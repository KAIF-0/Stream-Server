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
const PORT = process.env.PORT;

app.use(
  cors({
    origin: process.env.MAIN_URL,
  })
);

app.use(express.json());

//ffmpeg process ko dynamically start karne ke liye (with stream key)
let ffmpeg = null;
let streamKey = null;

const createFFmpegProcess = () => {
  if (!streamKey) {
    console.error("Stream key is missing! FFmpeg cannot start.");
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
    `rtmp://a.rtmp.youtube.com/live2/${streamKey}`, // Use the dynamic stream key
  ];

  ffmpeg = spawn("ffmpeg", options);

  ffmpeg.stdout.on("data", (data) => {
    console.log(`FFmpeg stdout: ${data}`);
  });

  ffmpeg.stderr.on("data", (data) => {
    console.error(`FFmpeg stderr: ${data}`);
  });

  ffmpeg.on("close", (code, signal) => {
    console.error(`FFmpeg process exited with ${code}, ${signal}`);
    if (code !== 0) {
      console.error("FFmpeg exited!");
    }
    ffmpeg = null;
  });
};

io.on("connection", (socket) => {
  console.log("A new user started stream:", socket.id);

  socket.on("streamKey", (key) => {
    console.log("Stream key received:", key);
    streamKey = key;

    if (!ffmpeg) {
      createFFmpegProcess();
    } else {
      console.warn("FFmpeg process is already running.");
    }
  });

  socket.on("streamData", (data) => {
    console.log("Stream data:", data.length, streamKey);

    if (ffmpeg && ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(data, (err) => {
        if (err) console.error("Write error:", err);
      });
    } else {
      console.error("FFmpeg stdin is not writable. Restarting FFmpeg...");
      createFFmpegProcess();
    }
  });
});

//kill ffmpeg process
app.delete("/end-stream", (req, res) => {
  if (ffmpeg) {
    ffmpeg.kill("SIGINT");
    console.log("FFmpeg process terminated.");
    ffmpeg = null;
    streamKey = null;
    res
      .status(200)
      .json({ success: true, message: "Stream stopped successfully." });
  } else {
    res
      .status(400)
      .json({ success: false, message: "No active FFmpeg process to stop." });
  }
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
