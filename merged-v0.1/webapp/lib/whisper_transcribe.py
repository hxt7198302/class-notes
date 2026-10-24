# -*- coding: utf-8 -*-
"""课堂助手 · 录音转写（faster-whisper, CPU int8）
用法: python whisper_transcribe.py --session <会话目录> --model <模型目录> --out <输出json> [--ffmpeg <ffmpeg>]
输出: {ok, model, tookMs, text, segments:[{start,end,text}]}
"""
import argparse, json, os, subprocess, sys, tempfile, time, wave
import numpy as np
from faster_whisper import WhisperModel


def ffmpeg_to_wav(src, dst, ffmpeg):
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-f', 'wav', dst], check=True)


def read_wav(path):
    with wave.open(path, 'rb') as w:
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--ffmpeg', default='ffmpeg')
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--prompt', default='')
    args = ap.parse_args()

    meta_path = os.path.join(args.session, 'meta.json')
    with open(meta_path, 'r', encoding='utf-8') as f:
        meta = json.load(f)
    segs = meta.get('segments') or []
    if not segs:
        result = {'ok': False, 'error': '没有录音段'}
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)
        print(json.dumps(result, ensure_ascii=False))
        return

    t0 = time.time()
    # 先把所有片段转成 16k wav，避免 GPU/CPU 重试时重复转码
    items = []
    with tempfile.TemporaryDirectory() as td:
        for i, seg in enumerate(segs):
            name = seg.get('name')
            if not name:
                continue
            src = os.path.join(args.session, 'rec', name)
            if not os.path.exists(src):
                continue
            wav = os.path.join(td, 'seg%d.wav' % i)
            try:
                ffmpeg_to_wav(src, wav, args.ffmpeg)
            except Exception as e:
                sys.stderr.write('ffmpeg fail %s: %s\n' % (name, e))
                continue
            items.append(((seg.get('offsetMs') or 0) / 1000.0, read_wav(wav)))
        if not items:
            result = {'ok': False, 'error': '录音段无法解码'}
            with open(args.out, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False)
            print(json.dumps(result, ensure_ascii=False))
            return

        def run(model, device):
            out = []
            for offset, audio in items:
                segments, info = model.transcribe(audio, language='zh', vad_filter=True, beam_size=5, initial_prompt=(args.prompt or None))
                for s in list(segments):
                    out.append({'start': round(offset + s.start, 2), 'end': round(offset + s.end, 2), 'text': (s.text or '').strip()})
            return out

        out_segs = []
        device_used = args.device
        if args.device == 'cuda':
            try:
                model = WhisperModel(args.model, device='cuda', compute_type='float16')
                out_segs = run(model, 'cuda')
            except Exception as e:
                sys.stderr.write('cuda failed, fallback cpu: %s\n' % repr(e)[:200])
                out_segs = []
                device_used = 'cpu'
        if not out_segs:
            model = WhisperModel(args.model, device='cpu', compute_type='int8')
            out_segs = run(model, 'cpu')
            device_used = 'cpu'
    text = ''.join(x['text'] for x in out_segs)
    result = {'ok': True, 'model': os.path.basename(os.path.normpath(args.model)), 'device': device_used, 'tookMs': int((time.time() - t0) * 1000), 'text': text, 'segments': out_segs}
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps({'ok': True, 'segments': len(out_segs), 'tookMs': result['tookMs'], 'text': text[:120]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
