"""듀얼 슬롯 검증: 두 슬롯 모두 표시 + 우측에서 도구 작용 + 메인 영향 X."""
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = Path(__file__).parent
SHOTS = BASE / "screenshots"
IMAGES = BASE / "test_images"

URL = "http://127.0.0.1:8765/"


def shot(page, name):
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=False)
    print(f"  → {name}.png")


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        page = b.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        page.on("pageerror", lambda exc: errors.append(f"ERR: {exc}"))
        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(400)

        page.set_input_files("#file-input", [
            str(IMAGES / "char_red.png"),
            str(IMAGES / "char_blue.png"),
        ])
        page.wait_for_timeout(700)
        page.click('label[for="ar-all"]')
        page.click("#btn-pixelize")
        page.wait_for_timeout(2000)

        # 분할 ON (slot 1 = 프레임 2)
        print("[1] 분할 ON (좌=프레임1, 우=프레임2)")
        page.select_option("#ref-frame-header", value="1")
        page.wait_for_timeout(500)
        shot(page, "dual_01_split")

        # state.slots 검증
        slots = page.evaluate("[state.slots[0].frameIdx, state.slots[1].frameIdx, state.activeSlot]")
        print(f"  slots[0/1].frameIdx + activeSlot = {slots}")

        # 좌측 캔버스 클릭 → activeSlot=0
        print("[2] 좌측 캔버스 클릭 → activeSlot=0")
        main_box = page.locator("#canvas").bounding_box()
        page.mouse.click(main_box["x"] + 50, main_box["y"] + 50)
        page.wait_for_timeout(200)
        active = page.evaluate("state.activeSlot")
        print(f"  activeSlot = {active}")

        # 우측 캔버스 클릭 → activeSlot=1
        print("[3] 우측 캔버스 클릭 → activeSlot=1")
        ref_box = page.locator("#ref-canvas").bounding_box()
        page.mouse.click(ref_box["x"] + 50, ref_box["y"] + 50)
        page.wait_for_timeout(200)
        active = page.evaluate("state.activeSlot")
        print(f"  activeSlot = {active}")
        shot(page, "dual_02_right_active")

        # 우측 슬롯에서 브러시 그리기
        print("[4] 우측 캔버스에서 브러시 그리기 (slot 1 frame에 작용해야)")
        page.click('label[for="tool-brush"]')
        page.wait_for_timeout(200)

        # 색 픽커 빨간색
        page.evaluate("state.activeColor = [255, 0, 0]; renderActiveColor();")

        ref_box = page.locator("#ref-canvas").bounding_box()
        cx = ref_box["x"] + ref_box["width"] * 0.5
        cy = ref_box["y"] + ref_box["height"] * 0.5
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 30, cy + 30, steps=5)
        page.mouse.up()
        page.wait_for_timeout(300)

        # 검증: slot 1의 frame이 변경됐는지 (slot 0은 그대로)
        s0_check = page.evaluate("state.frames[state.slots[0].frameIdx].pixelized")
        s1_check = page.evaluate("state.frames[state.slots[1].frameIdx].pixelized")
        print(f"  slot 0 frame.pixelized: {s0_check} / slot 1 frame.pixelized: {s1_check}")
        shot(page, "dual_03_painted_right")

        # 좌측에 그리기
        print("[5] 좌측 캔버스에 그리기 (slot 0 frame)")
        main_box = page.locator("#canvas").bounding_box()
        cx2 = main_box["x"] + main_box["width"] * 0.5
        cy2 = main_box["y"] + main_box["height"] * 0.5
        page.mouse.move(cx2, cy2)
        page.mouse.down()
        page.mouse.move(cx2 - 30, cy2 - 30, steps=5)
        page.mouse.up()
        page.wait_for_timeout(300)
        shot(page, "dual_04_painted_left")

        # 분할 OFF
        print("[6] 분할 OFF (드롭다운 비어있음)")
        page.select_option("#ref-frame-header", value="-1")
        page.wait_for_timeout(500)
        shot(page, "dual_05_off")

        print()
        if errors:
            print("ERRORS:", errors)
        else:
            print("(에러 없음)")
        b.close()


if __name__ == "__main__":
    main()
