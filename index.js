import express from "express";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import { spawn } from "child_process";

const app = express();
dotenv.config();

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.MAIN_URL,
    methods: ["GET", "POST"],
  },
});
const PORT = process.env.PORT || 8000;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS", "DELETE"],
    credentials: true,
  })
);

app.use(express.json());

//ffmpeg process ko dynamically start karne ke liye (with stream key) {new for every user}
const ffmpegProcesses = new Map();

const createFFmpegProcess = async (userId, streamKey) => {
  if (!streamKey) {
    console.log("Stream key is missing! FFmpeg cannot start.");
    return;
  }

  const options = [
    "-i",
    "-",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-r",
    `${25}`,
    "-g",
    `${25 * 2}`,
    "-keyint_min",
    25,
    "-crf",
    "25",
    "-pix_fmt",
    "yuv420p",
    "-sc_threshold",
    "0",
    "-profile:v",
    "main",
    "-level",
    "3.1",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    128000 / 4,
    "-f",
    "flv",
    `rtmp://a.rtmp.youtube.com/live2/${streamKey}`, // Using the stream key dynamically
  ];

  const ffmpeg = spawn("ffmpeg", options);

  ffmpeg.stdout.on("data", (data) => {
    console.log(`FFmpeg stdout: ${data}`);
  });

  ffmpeg.stderr.on("data", (data) => {
    console.error(`FFmpeg stderr: ${data}`);
  });

  ffmpeg.on("close", (code, signal) => {
    console.error(`FFmpeg process exited with ${code}, ${signal}`);
    ffmpegProcesses.delete(userId);
  });

  return ffmpeg;
};

io.on("connection", (socket) => {
  console.log("A new user started stream:", socket.id);

  socket.on("streamKey", async (data) => {
    const { streamKey, userId } = data;
    console.log("User ID:", userId);
    console.log("Stream key received:", streamKey);

    if (ffmpegProcesses.has(userId)) {
      console.log("Existing ffmpeg process deleting...");
      const existingProcess = ffmpegProcesses.get(userId);
      await existingProcess.kill("SIGTERM"); //killling existing ffmpeg process
      ffmpegProcesses.delete(userId);
    }

    const ffmpeg = await createFFmpegProcess(userId, streamKey);
    if (ffmpeg) {
      ffmpegProcesses.set(userId, ffmpeg);
      console.log("FFmpeg process started successfully.");
    }
  });

  socket.on("streamData", async (data) => {
    const { userId, streamData } = data;
    console.log("Stream data:", streamData.length, userId);
    const ffmpeg = ffmpegProcesses.get(userId);

    if (ffmpeg && ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(streamData, (err) => {
        if (err) console.error("Write error:", err);
      });
    } else {
      console.error("FFmpeg stdin is not writable!");
    }
  });

  socket.on("disconnect", async () => {
    console.log(`User ${socket.id} disconnected.`);
    const ffmpeg = ffmpegProcesses.get(socket.id);
    if (ffmpeg) {
      await ffmpeg.kill("SIGTERM");
      console.log("FFmpeg process terminated.");
      ffmpegProcesses.delete(socket.id);
    }
  });
});

app.delete("/end-stream/:userId", async (req, res) => {
  const { userId } = req.params;
  console.log(userId);

  if (!userId) {
    return res
      .status(400)
      .json({ success: false, message: "User ID is required." });
  }

  const ffmpeg = ffmpegProcesses.get(userId);
  if (ffmpeg) {
    await ffmpeg.kill("SIGTERM");
    console.log(`FFmpeg process terminated.`);
    ffmpegProcesses.delete(userId);
    return res.status(200).json({
      success: true,
      message: `Stream stopped successfully.`,
    });
  } else {
    return res.status(400).json({
      success: false,
      message: "No stream found for this user.",
    });
  }
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
