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
    const otherUser = Array.from(
      io.sockets.adapter.rooms.get(roomID) || [],
    ).find((id) => id !== socket.id);
    if (otherUser) {
      socket.emit("other-user", otherUser);
      socket.to(otherUser).emit("user-joined", socket.id);
    }
  });

  // Call management events
  socket.on("call-user", ({ userToCall, signal }) => {
    io.to(userToCall).emit("incoming-call", { signal, from: socket.id });
  });

  socket.on("accept-call", ({ to, signal }) => {
    io.to(to).emit("call-accepted", signal);
  });

  socket.on("reject-call", ({ to }) => {
    io.to(to).emit("call-rejected");
  });

  socket.on("offer", ({ payload, target }) => {
    io.to(target).emit("offer", { payload, caller: socket.id });
  });

  socket.on("answer", ({ payload, target }) => {
    io.to(target).emit("answer", { payload, caller: socket.id });
  });

  socket.on("ice-candidate", ({ target, candidate }) => {
    io.to(target).emit("ice-candidate", { candidate, sender: socket.id });
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    socket.broadcast.emit("user-disconnected", socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
