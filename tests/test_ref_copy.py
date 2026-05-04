"""참조 분할 뷰 + 복사/붙여넣기 자동 검증."""
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(__file__).parent
SHOTS = BASE / "screenshots"
IMAGES = BASE / "test_images"
SHOTS.mkdir(exist_ok=True)

URL = "http://127.0.0.1:8765/"


def shot(page, name: str):
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=False)
    print(f"  → {name}.png")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 1000})
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(f"[ERROR] {exc}"))
        page.on("console", lambda msg: errors.append(f"[{msg.type}] {msg.text}") if msg.type == "error" else None)

        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(400)

        print("[1] 이미지 4장 로드")
        files = [str(IMAGES / f) for f in ["char_red.png", "char_blue.png", "char_green.png", "char_yellow.png"]]
        page.set_input_files("#file-input", files)
        page.wait_for_timeout(600)

        print("[2] 모든 프레임 도트화 (격자 64, 우세, 16색)")
        page.click('label[for="g64"]')
        page.click('label[for="c16"]')
        page.click('label[for="ar-all"]')
        page.click("#btn-pixelize")
        page.wait_for_timeout(2200)

        print("[3] 참조 모드 ON")
        page.click("#btn-ref-toggle")
        page.wait_for_timeout(400)
        shot(page, "ref_01_split_on")

        print("[4] 참조 프레임 = 2 (frame index 1)")
        page.select_option("#ref-frame-select", value="1")
        page.wait_for_timeout(300)
        shot(page, "ref_02_frame2_selected")

        print("[5] 사각형 도구로 머리 영역 선택")
        page.click('label[for="tool-rect"]')
        page.wait_for_timeout(200)
        # 메인 캔버스 영역에서 드래그 (대략 머리 위치)
        # 캔버스 사이즈 추정 → 좌상단 + 머리 부분 박스
        canvas_box = page.locator("#canvas").bounding_box()
        if canvas_box:
            cx = canvas_box["x"]
            cy = canvas_box["y"]
            cw = canvas_box["width"]
            ch = canvas_box["height"]
            # 머리 영역 추정: 가운데 위쪽 1/3
            x1 = cx + cw * 0.35
            y1 = cy + ch * 0.18
            x2 = cx + cw * 0.65
            y2 = cy + ch * 0.50
            page.mouse.move(x1, y1)
            page.mouse.down()
            page.mouse.move(x2, y2, steps=10)
            page.mouse.up()
            page.wait_for_timeout(300)
        shot(page, "ref_03_selection")

        print("[6] Ctrl+C 복사")
        page.keyboard.press("Control+c")
        page.wait_for_timeout(300)

        print("[7] 다음 프레임 이동")
        page.click("#tl-next")
        page.wait_for_timeout(300)
        shot(page, "ref_04_after_next")

        print("[8] Ctrl+V 붙여넣기")
        page.keyboard.press("Control+v")
        page.wait_for_timeout(500)
        shot(page, "ref_05_after_paste")

        print("[9] 참조 끄기")
        page.click("#btn-ref-close")
        page.wait_for_timeout(400)
        shot(page, "ref_06_split_off")

        print()
        print("--- 콘솔 / 에러 ---")
        for m in errors:
            print(m)
        if not errors:
            print("(에러 없음)")

        browser.close()
        print(f"\n저장: {SHOTS}")


if __name__ == "__main__":
    main()
