"""Encode Qwen's 16-bit mono PCM without changing the streaming path."""

from fractions import Fraction
from pathlib import Path
import wave


def write_pcm_audio(pcm: bytes, output_path: Path, format: str, sample_rate: int) -> Path:
    if format not in {"wav", "pcm", "mp3"}:
        raise ValueError(f"Unsupported Qwen audio output format: {format}")
    if not pcm or len(pcm) % 2:
        raise ValueError("Expected nonempty, complete 16-bit PCM samples")
    output_path = output_path.with_suffix(f".{format}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if format == "pcm":
        output_path.write_bytes(pcm)
    elif format == "wav":
        with wave.open(str(output_path), "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(sample_rate)
            target.writeframes(pcm)
    else:
        import av

        with av.open(str(output_path), mode="w", format="mp3") as target:
            stream = target.add_stream("libmp3lame", rate=sample_rate)
            stream.layout = "mono"
            stream.bit_rate = 96000
            for offset in range(0, len(pcm), 8192):
                raw = pcm[offset:offset + 8192]
                frame = av.AudioFrame(format="s16", layout="mono", samples=len(raw) // 2)
                frame.sample_rate = sample_rate
                frame.time_base = Fraction(1, sample_rate)
                frame.pts = offset // 2
                frame.planes[0].update(raw)
                for packet in stream.encode(frame):
                    target.mux(packet)
            for packet in stream.encode(None):
                target.mux(packet)
    return output_path

