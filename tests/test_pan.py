"""참조 분할 ON 상태에서 메인 캔버스 손바닥 이동(pan) 테스트."""
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(__file__).parent
SHOTS = BASE / "screenshots"
IMAGES = BASE / "test_images"

URL = "http://127.0.0.1:8765/"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        page.on("pageerror", lambda exc: errors.append(f"ERROR: {exc}"))

        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(400)

        # 이미지 2장 로드
        page.set_input_files("#file-input", [
            str(IMAGES / "char_red.png"),
            str(IMAGES / "char_blue.png"),
        ])
        page.wait_for_timeout(700)

        # 도트화 (모든 프레임)
        page.click('label[for="ar-all"]')
        page.click("#btn-pixelize")
        page.wait_for_timeout(2000)

        # 줌 인 (1키 = 100%) — pan이 의미 있도록
        page.keyboard.press("1")
        page.wait_for_timeout(300)

        # pan 전 layout 확인
        layout_before = page.evaluate("JSON.stringify(state.layout)")
        print(f"layout BEFORE pan : {layout_before}")
        pan_before = page.evaluate("[state.panX, state.panY]")
        print(f"panX/Y  BEFORE     : {pan_before}")

        # 단일 뷰에서 Space + 드래그 pan 시도
        canvas_box = page.locator("#canvas").bounding_box()
        cx = canvas_box["x"] + canvas_box["width"] / 2
        cy = canvas_box["y"] + canvas_box["height"] / 2

        print("\n[A] 단일 뷰 Space + 드래그")
        page.keyboard.down("Space")
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 100, cy + 50, steps=10)
        page.mouse.up()
        page.keyboard.up("Space")
        page.wait_for_timeout(200)
        pan_a = page.evaluate("[state.panX, state.panY]")
        print(f"  panX/Y after pan : {pan_a}")

        # 참조 ON (드롭다운에서 프레임 1 선택)
        print("\n[B] 참조 분할 ON")
        page.select_option("#ref-frame-header", value="0")
        page.wait_for_timeout(400)
        body_class = page.evaluate("document.body.className")
        print(f"  body class       : {body_class!r}")

        # 참조 ON 상태에서 다시 pan 시도
        page.evaluate("state.panX = 0; state.panY = 0;")  # 리셋
        canvas_box = page.locator("#canvas").bounding_box()
        cx = canvas_box["x"] + canvas_box["width"] / 2
        cy = canvas_box["y"] + canvas_box["height"] / 2
        print(f"  canvas box (split): {canvas_box}")

        print("\n[C] 분할 상태에서 Space + 드래그")
        page.keyboard.down("Space")
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 100, cy + 50, steps=10)
        page.mouse.up()
        page.keyboard.up("Space")
        page.wait_for_timeout(200)
        pan_c = page.evaluate("[state.panX, state.panY]")
        print(f"  panX/Y after pan : {pan_c}")

        # 미들 버튼 드래그
        print("\n[D] 분할 상태에서 미들 버튼 드래그")
        page.evaluate("state.panX = 0; state.panY = 0;")
        page.mouse.move(cx, cy)
        page.mouse.down(button="middle")
        page.mouse.move(cx - 80, cy - 40, steps=10)
        page.mouse.up(button="middle")
        page.wait_for_timeout(200)
        pan_d = page.evaluate("[state.panX, state.panY]")
        print(f"  panX/Y after pan : {pan_d}")

        print("\nerrors:", errors or "(없음)")
        browser.close()


if __name__ == "__main__":
    main()
