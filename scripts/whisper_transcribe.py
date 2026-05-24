#!/usr/bin/env python3
"""
Whisper 本地语音转写脚本
用于 VisionMark 项目的 ASR fallback 方案

使用方法:
  python whisper_transcribe.py --audio input.wav --model base --language zh --output-format json

输出 (stdout): JSON 格式的转录结果
  {"segments": [{"start": 0.0, "end": 2.5, "text": "文本"}]}
"""

import argparse
import json
import sys
import os


def main():
    parser = argparse.ArgumentParser(description='Whisper 语音转写')
    parser.add_argument('--audio', required=True, help='音频文件路径')
    parser.add_argument('--model', default='base', 
                        choices=['tiny', 'base', 'small', 'medium', 'large'],
                        help='Whisper 模型大小')
    parser.add_argument('--language', default='zh', help='语言提示')
    parser.add_argument('--output-format', default='json', choices=['json', 'text'],
                        help='输出格式')
    args = parser.parse_args()

    # 检查音频文件
    if not os.path.exists(args.audio):
        print(json.dumps({"error": f"音频文件不存在: {args.audio}"}), file=sys.stderr)
        sys.exit(1)

    try:
        import whisper
    except ImportError:
        print(json.dumps({"error": "未安装 openai-whisper，请运行: pip install openai-whisper"}), 
              file=sys.stderr)
        sys.exit(1)

    # 加载模型
    print(f"[Whisper] 加载模型: {args.model}", file=sys.stderr)
    model = whisper.load_model(args.model)

    # 执行转写
    print(f"[Whisper] 开始转写: {args.audio}", file=sys.stderr)
    result = model.transcribe(
        args.audio,
        language=args.language,
        verbose=False,
        word_timestamps=False
    )

    # 构造输出
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": round(seg["start"], 2),
            "end": round(seg["end"], 2),
            "text": seg["text"].strip()
        })

    output = {"segments": segments}

    if args.output_format == 'json':
        print(json.dumps(output, ensure_ascii=False))
    else:
        for seg in segments:
            print(f"[{seg['start']:.1f}-{seg['end']:.1f}] {seg['text']}")

    print(f"[Whisper] 转写完成，共 {len(segments)} 段", file=sys.stderr)


if __name__ == '__main__':
    main()
