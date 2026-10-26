# -*- coding: utf-8 -*-
"""
课堂录音转写脚本（faster-whisper，GPU 验证通过才用 GPU，失败退 CPU 保底）。
踩坑沉淀（来自 20260916 录音总结）：Windows 下 cublas64_12.dll 不在系统路径，
必须把 site-packages\\nvidia 下的 DLL 目录挂进 PATH 并 set_cuda_library_paths；
HF 下载要禁 Xet。
用法：python transcribe.py --input <录音> --outdir <输出目录> [--model large-v3] [--lang zh]
输出：<outdir>/transcript.json  [{"s":秒,"e":秒,"t":"文本"}, ...]
      <outdir>/transcript.txt  纯文本（带 [mm:ss] 前缀）
      <outdir>/transcribe.done 成功标记（内含摘要）；失败时不产生
进度写 <outdir>/status.json（state=transcribing, progress=0~100）。
"""
import argparse
import json
import os
import site
import sys
import time

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
if os.name == "nt":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# ---- nvidia DLL 路径（CUDA 转写的关键，须在 import ctranslate2 前挂好）----
_dll_dirs = []
for _p in site.getsitepackages():
    _nv = os.path.join(_p, "nvidia")
    if os.path.isdir(_nv):
        for _root, _dirs, _files in os.walk(_nv):
            if _root.endswith(("bin", "lib")) and any(f.lower().endswith(".dll") for f in _files):
                _dll_dirs.append(_root)
                try:
                    os.add_dll_directory(_root)
                except OSError:
                    pass
if _dll_dirs:
    os.environ["PATH"] = ";".join(_dll_dirs) + ";" + os.environ["PATH"]

import ctranslate2  # noqa: E402
if _dll_dirs and hasattr(ctranslate2, "set_cuda_library_paths"):
    ctranslate2.set_cuda_library_paths(_dll_dirs)

from faster_whisper import WhisperModel  # noqa: E402
from faster_whisper.audio import decode_audio  # noqa: E402


def write_status(outdir, patch):
    f = os.path.join(outdir, "status.json")
    cur = {}
    try:
        with open(f, "r", encoding="utf-8") as fh:
            cur = json.load(fh)
    except Exception:
        pass
    cur.update(patch)
    cur["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    tmp = f + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cur, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, f)


def fmt_ts(sec):
    sec = int(sec)
    return f"{sec // 60:02d}:{sec % 60:02d}"


def gpu_probe(model_name):
    """用 10 秒小样验证 GPU 真能跑（DLL 全/显存够），返回 (model实例, 引擎描述) 或 (None, 失败原因)"""
    try:
        m = WhisperModel(model_name, device="cuda", compute_type="float16")
        probe = decode_audio(PROBE_WAV, sampling_rate=16000)[:16000]
        segs, _ = m.transcribe(probe, language="zh")
        list(segs)  # 拉一段才真正过 GPU
        return m, f"cuda/float16/{model_name}"
    except Exception as e:
        return None, f"{type(e).__name__}: {str(e)[:200]}"


PROBE_WAV = ""  # main 里生成


def main():
    global PROBE_WAV
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--lang", default="zh")
    # v2.8 课程术语热词（空格分隔）。只在当前段解码时参与，不改 initial_prompt——
    # 用 prompt 前缀会导致模型把提示词当上一句"接着往下念"（回声 bug），hotwords 不会。
    ap.add_argument("--hotwords", default="")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    t0 = time.time()
    write_status(args.outdir, {"state": "transcribing", "progress": 0, "model": args.model})
    print(f"[transcribe] 输入={args.input} 期望模型={args.model}", flush=True)

    audio = decode_audio(args.input, sampling_rate=16000)
    total_sec = len(audio) / 16000
    print(f"[transcribe] 解码 OK：{total_sec/60:.1f} 分钟", flush=True)

    # 探针小样（写临时 wav 供 GPU 验证）
    import wave
    import struct
    PROBE_WAV = os.path.join(args.outdir, "_probe.wav")
    with wave.open(PROBE_WAV, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        for smp in audio[:16000]:
            w.writeframes(struct.pack("<h", max(-32768, min(32767, int(smp * 32767)))))

    model, engine = gpu_probe(args.model)
    if model is None:
        print(f"[transcribe] GPU 验证失败退 CPU：{engine}", flush=True)
        cpu_model = "small" if args.model not in ("small", "base", "tiny") else args.model
        model = WhisperModel(cpu_model, device="cpu", compute_type="int8")
        engine = f"cpu/int8/{cpu_model}"
    print(f"[transcribe] 引擎：{engine}", flush=True)

    tkw = dict(
        language=args.lang if args.lang != "auto" else None,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 700},
        beam_size=5,
        condition_on_previous_text=False,
    )
    hotwords = (args.hotwords or "").strip()
    if hotwords:
        # 老版本 faster-whisper 没有 hotwords 参数：静默退回纯转写，绝不因热词整段失败
        try:
            import inspect
            if "hotwords" in inspect.signature(model.transcribe).parameters:
                tkw["hotwords"] = hotwords
                print(f"[transcribe] 术语热词：{hotwords}", flush=True)
            else:
                print("[transcribe] 当前 faster-whisper 不支持 hotwords，已跳过", flush=True)
        except Exception as e:
            print(f"[transcribe] 热词探测失败，已跳过：{e}", flush=True)
    segments, info = model.transcribe(args.input, **tkw)

    rows, txt_lines = [], []
    last_flush = 0
    with open(os.path.join(args.outdir, "transcript.json"), "w", encoding="utf-8") as fj, \
         open(os.path.join(args.outdir, "transcript.txt"), "w", encoding="utf-8") as ft:
        for seg in segments:
            rows.append({"s": round(seg.start, 2), "e": round(seg.end, 2), "t": seg.text.strip()})
            txt_lines.append(f"[{fmt_ts(seg.start)}] {seg.text.strip()}")
            if time.time() - last_flush > 5:
                last_flush = time.time()
                write_status(args.outdir, {"progress": min(99, int(seg.end / max(info.duration, 0.1) * 100))})
                fj.seek(0); fj.truncate()
                json.dump(rows, fj, ensure_ascii=False)
                fj.flush()
        ft.seek(0); ft.truncate()
        ft.write("\n".join(txt_lines)); ft.flush()
        # json 也要收尾全量写一次（中途的增量刷盘是给进度用的，末尾几段可能还没进去）
        fj.seek(0); fj.truncate()
        json.dump(rows, fj, ensure_ascii=False)
        fj.flush()

    try:
        os.remove(PROBE_WAV)
    except OSError:
        pass
    if not rows:
        raise RuntimeError("一段话都没转出来（可能是静音文件）")

    dur = time.time() - t0
    summary = {
        "state": "transcribed",
        "progress": 100,
        "segments": len(rows),
        "audioMinutes": round(info.duration / 60, 1),
        "tookSec": round(dur, 1),
        "language": info.language,
        "engine": engine,
        "hotwords": hotwords,
    }
    write_status(args.outdir, summary)
    with open(os.path.join(args.outdir, "transcribe.done"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False)
    print(f"[transcribe] 完成：{len(rows)} 段 / 引擎 {engine} / 耗时 {dur:.0f} 秒", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        try:
            ap2 = argparse.ArgumentParser()
            ap2.add_argument("--outdir", default=".")
            (o, _) = ap2.parse_known_args()
            write_status(o.outdir, {"state": "transcribe-error", "error": str(e)[:500]})
        except Exception:
            pass
        print(f"[transcribe] 失败：{e}", file=sys.stderr, flush=True)
        sys.exit(1)
