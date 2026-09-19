// Prototipo de coordinador WDF.
// IMPORTANTE: Edge Functions son serverless y pueden reiniciarse/escalares.
// Este coordinador sirve para pruebas y primeras partidas, pero el estado
// definitivo del matchmaking debería migrarse a Postgres/Realtime cuando
// el WDF tenga jugadores reales a escala.

type Player = {
  id: string;
  name: string;
  songs: string[];
  socket: WebSocket;
  votes?: number;
  score?: number;
};

type Room = {
  id: string;
  players: Map<string, Player>;
  phase: "waiting" | "voting" | "playing" | "results";
  options: string[];
  votes: Map<string, number>;
};

const rooms = new Map<string, Room>();
const queue: Player[] = [];

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function commonSongs(players: Player[]) {
  if (!players.length) return [];
  let common = new Set(players[0].songs);
  for (const p of players.slice(1)) {
    common = new Set([...common].filter(x => p.songs.includes(x)));
  }
  return [...common];
}

function findRoomFor(player: Player) {
  for (const room of rooms.values()) {
    if (room.phase !== "waiting") continue;
    const members = [...room.players.values()];
    if (members.length >= 6) continue;
    if (commonSongs([...members, player]).length > 0) return room;
  }
  return null;
}

function broadcast(room: Room, payload: unknown) {
  for (const p of room.players.values()) send(p.socket, payload);
}

function makeOptions(room: Room) {
  const songs = commonSongs([...room.players.values()]);
  if (songs.length < 1) return [];
  // Mezcla Fisher-Yates sencilla.
  for (let i = songs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [songs[i], songs[j]] = [songs[j], songs[i]];
  }
  return songs.slice(0, Math.min(2, songs.length));
}

function enterQueue(player: Player) {
  const room = findRoomFor(player);
  if (room) {
    room.players.set(player.id, player);
    broadcast(room, {
      type: "players",
      players: [...room.players.values()].map(p => ({
        id: p.id,
        name: p.name,
      })),
    });

    if (room.players.size >= 2) {
      room.options = makeOptions(room);
      if (room.options.length === 1) {
        room.phase = "voting";
        room.votes.clear();
        broadcast(room, {
          type: "vote_options",
          songs: room.options,
          seconds: 15,
        });
      }
    }
    return room;
  }

  queue.push(player);
  const newRoom: Room = {
    id: crypto.randomUUID(),
    players: new Map([[player.id, player]]),
    phase: "waiting",
    options: [],
    votes: new Map(),
  };
  rooms.set(newRoom.id, newRoom);
  send(player.socket, { type: "match_found", room_id: newRoom.id });
  return newRoom;
}

function handleMessage(socket: WebSocket, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(socket, { type: "error", code: "INVALID_JSON" });
    return;
  }

  if (msg.type === "join") {
    const player: Player = {
      id: String(msg.player_id),
      name: String(msg.username || "Player").slice(0, 16),
      songs: Array.isArray(msg.songs) ? [...new Set(msg.songs.map(String))].slice(0, 2000) : [],
      socket,
      score: 0,
    };

    if (!player.songs.length) {
      send(socket, { type: "error", code: "NO_SONGS" });
      return;
    }

    const room = enterQueue(player);
    send(socket, {
      type: "welcome",
      player_id: player.id,
      room_id: room.id,
    });
    return;
  }

  if (msg.type === "vote") {
    for (const room of rooms.values()) {
      const player = room.players.get(String(msg.player_id));
      if (!player || room.phase !== "voting") continue;

      const choice = Number(msg.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= room.options.length) {
        send(socket, { type: "error", code: "INVALID_VOTE" });
        return;
      }

      room.votes.set(player.id, choice);
      const counts = room.options.map((_, i) =>
        [...room.votes.values()].filter(v => v === i).length
      );

      broadcast(room, { type: "vote_update", votes: counts });

      if (room.votes.size >= room.players.size) {
        const winner = counts[0] >= counts[1] ? 0 : 1;
        const song = room.options[winner];
        room.phase = "playing";
        broadcast(room, {
          type: "vote_result",
          winner: song,
          votes: counts,
        });
        broadcast(room, {
          type: "round_start",
          song,
          countdown: 3,
        });
      }
      return;
    }
    return;
  }

  if (msg.type === "score") {
    for (const room of rooms.values()) {
      const player = room.players.get(String(msg.player_id));
      if (!player || room.phase !== "playing") continue;

      const score = Number(msg.score);
      if (Number.isFinite(score)) player.score = Math.max(0, Math.floor(score));

      broadcast(room, {
        type: "scores",
        scores: [...room.players.values()].map(p => ({
          id: p.id,
          name: p.name,
          score: p.score || 0,
        })),
      });
      return;
    }
  }
}

Deno.serve((req) => {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({
        service: "Puppet Dance World Floor",
        status: "ok",
      }),
      { headers: { "content-type": "application/json" } }
    );
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    send(socket, {
      type: "server_ready",
      protocol: 1,
    });
  };

  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      handleMessage(socket, event.data);
    }
  };

  socket.onerror = () => {};
  socket.onclose = () => {
    for (const room of rooms.values()) {
      for (const [id, player] of room.players) {
        if (player.socket === socket) {
          room.players.delete(id);
        }
      }
      if (!room.players.size) rooms.delete(room.id);
    }
  };

  return response;
});
