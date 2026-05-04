"""테스트용 캐릭터 이미지 생성 — 간단한 도형 캐릭터 4 방향."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "test_images")
os.makedirs(OUT, exist_ok=True)


def make_character(name: str, body_color, head_color=(255, 220, 180)):
    img = Image.new("RGBA", (256, 256), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    # 머리
    d.ellipse((80, 40, 176, 136), fill=head_color, outline=(40, 40, 40), width=2)
    # 눈
    d.ellipse((105, 75, 115, 90), fill=(0, 0, 0))
    d.ellipse((140, 75, 150, 90), fill=(0, 0, 0))
    # 입
    d.arc((115, 95, 145, 115), start=0, end=180, fill=(120, 60, 60), width=2)
    # 몸통
    d.rectangle((100, 130, 156, 200), fill=body_color, outline=(40, 40, 40), width=2)
    # 팔
    d.line((100, 140, 60, 180), fill=body_color, width=10)
    d.line((156, 140, 196, 180), fill=body_color, width=10)
    # 다리
    d.line((116, 200, 110, 240), fill=(60, 60, 60), width=10)
    d.line((140, 200, 146, 240), fill=(60, 60, 60), width=10)
    img.save(os.path.join(OUT, f"{name}.png"))
    print(f"  {name}.png")


print("Test images:")
make_character("char_red", (200, 70, 70))
make_character("char_blue", (70, 100, 200))
make_character("char_green", (70, 180, 100))
make_character("char_yellow", (220, 200, 60))
print("Done.")
