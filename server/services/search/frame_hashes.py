import json
import sys

from PIL import Image


def average_hash(image_path):
    with Image.open(image_path) as image:
        pixels = list(image.convert("L").resize((8, 8)).getdata())
    average = sum(pixels) / len(pixels)
    bits = 0
    for value in pixels:
        bits = (bits << 1) | int(value >= average)
    return f"{bits:016x}"


def main():
    paths = json.load(sys.stdin)
    result = {}
    for path in paths:
        try:
            result[path] = average_hash(path)
        except Exception:
            result[path] = None
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
