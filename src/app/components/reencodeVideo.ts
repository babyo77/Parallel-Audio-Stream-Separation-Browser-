// Utility to re-encode a video blob using @ffmpeg/ffmpeg (new API)
import { fetchFile } from "@ffmpeg/util";
import type { FFmpeg } from "@ffmpeg/ffmpeg";

export default async function reencodeVideo(
  ffmpeg: FFmpeg,
  blob: Blob
): Promise<Blob> {
  const outputFileName = "output.mp4";

  await ffmpeg.writeFile("input.webm", await fetchFile(blob));

  await ffmpeg.exec([
    "-i",
    "input.webm",
    "-preset",
    "superfast",
    "-threads",
    "0",
    "-r",
    "30",
    "-tune",
    "fastdecode",
    outputFileName,
  ]);
  // Read output file
  const data = await ffmpeg.readFile(outputFileName);
  return new Blob([data], { type: "video/mp4" });
}
