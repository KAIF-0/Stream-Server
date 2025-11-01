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
    origin: [process.env.MAIN_URL],
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e8, // 100 MB buffer size for large video chunks
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

const ffmpegProcesses = new Map();

const createFFmpegProcess = async (userId, streamKey) => {
  if (!streamKey) {
    console.log("Stream key is missing! FFmpeg cannot start.");
    return;
  }

  const options = [
  "-re", // read input at native frame rate
  "-f", "webm", // input format from browser
  "-use_wallclock_as_timestamps", "1",
  "-thread_queue_size", "1024",
  "-i", "pipe:0",

  // Video
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-tune", "zerolatency",
  "-b:v", "3500k",
  "-maxrate", "3500k",
  "-bufsize", "7000k",
  "-pix_fmt", "yuv420p",
  "-r", "30",
  "-g", "60",
  "-keyint_min", "30",
  "-profile:v", "high",
  "-level", "4.1",

  // Audio
  "-c:a", "aac",
  "-b:a", "128k",
  "-ar", "44100",
  "-ac", "2",

  "-f", "flv",
  `rtmp://a.rtmp.youtube.com/live2/${streamKey}`,
];



  const ffmpeg = spawn("ffmpeg", options, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  ffmpeg.stdin.on('error', (err) => {
    console.error(`FFmpeg stdin error for ${userId}:`, err.message);
  });

  ffmpeg.stdout.on("data", (data) => {
    console.log(`FFmpeg stdout [${userId}]: ${data}`);
  });

  ffmpeg.stderr.on("data", (data) => {
    const message = data.toString();
    if (message.includes('error') || message.includes('Error')) {
      console.error(`FFmpeg stderr [${userId}]: ${message}`);
    } else {
      if (message.includes('frame=') || message.includes('time=')) {
        console.log(`FFmpeg progress [${userId}]: ${message.trim()}`);
      }
    }
  });

  ffmpeg.on("close", (code, signal) => {
    console.log(`FFmpeg process [${userId}] exited with code ${code}, signal ${signal}`);
    ffmpegProcesses.delete(userId);
  });

  ffmpeg.on("error", (err) => {
    console.error(`FFmpeg process error [${userId}]:`, err);
    ffmpegProcesses.delete(userId);
  });

  return ffmpeg;
};

io.on("connection", (socket) => {
  console.log("A new user connected:", socket.id);

  socket.on("streamKey", async (data) => {
    const { streamKey, userId } = data;
    console.log("User ID:", userId);
    console.log("Stream key received:", streamKey);

    if (ffmpegProcesses.has(userId)) {
      console.log("Existing ffmpeg process found, terminating...");
      const existingProcess = ffmpegProcesses.get(userId);
      try {
        existingProcess.stdin.end();
        existingProcess.kill("SIGTERM");
      } catch (err) {
        console.error("Error killing existing process:", err);
      }
      ffmpegProcesses.delete(userId);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const ffmpeg = await createFFmpegProcess(userId, streamKey);
    if (ffmpeg) {
      ffmpegProcesses.set(userId, ffmpeg);
      console.log("FFmpeg process started successfully for user:", userId);
      socket.emit("streamStarted", { success: true });
    } else {
      socket.emit("streamStarted", { success: false, error: "Failed to start FFmpeg" });
    }
  });

  socket.on("streamData", async (data) => {
    const { userId, streamData } = data;
    
    if (!streamData) {
      console.error("No stream data received");
      return;
    }

    const ffmpeg = ffmpegProcesses.get(userId);

    if (ffmpeg && ffmpeg.stdin.writable) {
      try {
        const buffer = Buffer.from(streamData);
        console.log(`Writing ${buffer.length} bytes for user ${userId}`);
        
        ffmpeg.stdin.write(buffer, (err) => {
          if (err) {
            console.error(`Write error for ${userId}:`, err.message);
          }
        });
      } catch (err) {
        console.error(`Error processing stream data for ${userId}:`, err);
      }
    } else {
      console.error(`FFmpeg stdin is not writable for user ${userId}!`);
    }
  });

  socket.on("endStream", async (data) => {
    const { userId } = data;
    console.log("Ending stream for userId:", userId);
    
    const ffmpeg = ffmpegProcesses.get(userId);
    if (ffmpeg) {
      try {
        if (ffmpeg.stdin.writable) {
          ffmpeg.stdin.end();
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        ffmpeg.kill("SIGTERM");
        console.log("FFmpeg process terminated for user:", userId);
      } catch (err) {
        console.error("Error ending stream:", err);
      }
      ffmpegProcesses.delete(userId);
    }
  });

  socket.on("disconnect", async () => {
    console.log(`User ${socket.id} disconnected`);
  });
});

app.delete("/end-stream/:userId", async (req, res) => {
  const { userId } = req.params;
  console.log("HTTP request to end stream for userId:", userId);

  if (!userId) {
    return res
      .status(400)
      .json({ success: false, message: "User ID is required." });
  }

  const ffmpeg = ffmpegProcesses.get(userId);
  if (ffmpeg) {
    try {
      if (ffmpeg.stdin.writable) {
        ffmpeg.stdin.end();
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      ffmpeg.kill("SIGTERM");
      console.log(`FFmpeg process terminated for user ${userId}`);
      ffmpegProcesses.delete(userId);
      
      return res.status(200).json({
        success: true,
        message: `Stream stopped successfully.`,
      });
    } catch (err) {
      console.error("Error stopping stream:", err);
      return res.status(500).json({
        success: false,
        message: "Error stopping stream: " + err.message,
      });
    }
  } else {
    return res.status(404).json({
      success: false,
      message: "No stream found for this user.",
    });
  }
});

app.get("/", (req, res) => {
  res.send("YouTube Streaming Server is running!");
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, cleaning up...');
  ffmpegProcesses.forEach((ffmpeg, userId) => {
    try {
      if (ffmpeg.stdin.writable) {
        ffmpeg.stdin.end();
      }
      ffmpeg.kill('SIGTERM');
    } catch (err) {
      console.error(`Error cleaning up FFmpeg for ${userId}:`, err);
    }
  });
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
