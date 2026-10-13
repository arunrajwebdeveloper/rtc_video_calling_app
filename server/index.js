import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("join-room", (roomID) => {
    socket.join(roomID);
    console.log(`User ${socket.id} joined room: ${roomID}`);

    const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomID) || []);
    const otherUsers = roomSockets.filter((id) => id !== socket.id);

    // Send existing users in room to the newcomer
    socket.emit("room-users", otherUsers);
    // Notify others in room
    socket.to(roomID).emit("user-joined", socket.id);
  });

  socket.on("call-user", ({ offer, target }) => {
    io.to(target).emit("incoming-call", { offer, caller: socket.id });
  });

  socket.on("accept-call", ({ answer, target }) => {
    io.to(target).emit("call-accepted", { answer });
  });

  socket.on("reject-call", ({ target }) => {
    io.to(target).emit("call-rejected");
  });

  socket.on("cancel-call", ({ target }) => {
    io.to(target).emit("call-cancelled");
  });

  socket.on("ice-candidate", ({ target, candidate }) => {
    io.to(target).emit("ice-candidate", { candidate });
  });

  socket.on("hang-up", ({ target }) => {
    if (target) {
      io.to(target).emit("hang-up");
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    socket.broadcast.emit("user-disconnected");
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
