"""PixelMotion 기본 워크플로우 자동 테스트.
서버가 http://127.0.0.1:8765 에서 동작 중이어야 함.
"""
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = Path(__file__).parent
SHOTS = BASE / "screenshots"
IMAGES = BASE / "test_images"
SHOTS.mkdir(exist_ok=True)

URL = "http://127.0.0.1:8765/"


def shot(page, name: str):
    path = SHOTS / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    print(f"  → {name}.png")


def main():
    print("PixelMotion 자동 테스트 시작")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1600, "height": 1000})
        page = context.new_page()

        console_msgs = []
        page.on("console", lambda msg: console_msgs.append(f"[{msg.type}] {msg.text}"))
        page.on("pageerror", lambda exc: console_msgs.append(f"[ERROR] {exc}"))

        # 1. 페이지 로드
        print("\n[1] 페이지 로드")
        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(500)
        shot(page, "01_initial")

        # 2. 이미지 4장 추가
        print("\n[2] 이미지 4장 업로드")
        files = [str(IMAGES / f) for f in ["char_red.png", "char_blue.png", "char_green.png", "char_yellow.png"]]
        page.set_input_files("#file-input", files)
        page.wait_for_timeout(800)
        shot(page, "02_4frames_loaded")

        # 3. 격자 128로 변경 + 모드 디테일 + 색 16
        print("\n[3] 도트화 옵션 설정")
        page.click('label[for="g128"]')
        page.click('label[for="ds-det"]')
        page.click('label[for="c16"]')
        page.wait_for_timeout(200)
        shot(page, "03_options_set")

        # 4. 적용 범위 = 모든 프레임 + 도트화 실행
        print("\n[4] 모든 프레임 도트화")
        page.click('label[for="ar-all"]')
        page.click("#btn-pixelize")
        page.wait_for_timeout(2500)  # 도트화 처리 대기
        shot(page, "04_pixelized_all")

        # 5. 다음 프레임 이동 + 어니언 스킨 확인
        print("\n[5] 어니언 스킨 ON + 프레임 전환")
        page.click("#tl-next")
        page.check("#tl-onion")
        page.wait_for_timeout(400)
        shot(page, "05_onion_skin")

        # 6. 트레이싱 모드 ON
        print("\n[6] 트레이싱 모드 활성")
        page.click("#tracing-mode")
        page.wait_for_timeout(200)
        shot(page, "06_tracing_on")

        # 7. 단축키 B (브러시) 테스트
        print("\n[7] 단축키 B로 브러시 전환")
        page.keyboard.press("b")
        page.wait_for_timeout(300)
        shot(page, "07_brush_via_shortcut")

        # 8. F1 단축키 안내 모달
        print("\n[8] F1 단축키 안내")
        page.keyboard.press("F1")
        page.wait_for_timeout(400)
        shot(page, "08_shortcuts_modal")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)

        # 9. 색 픽커 열기
        print("\n[9] 색 픽커 열기")
        # 어니언 끄기 (스크린샷 깔끔하게)
        page.uncheck("#tl-onion")
        page.wait_for_timeout(200)
        page.click("#active-color-box")
        page.wait_for_timeout(400)
        shot(page, "09_color_picker")

        # 10. 좌우 반전
        print("\n[10] 좌우 반전")
        page.click("#btn-flip-h")
        page.wait_for_timeout(500)
        shot(page, "10_flipped")

        # 11. 저장 메뉴 (Ctrl+S)
        print("\n[11] Ctrl+S 저장 메뉴")
        page.keyboard.press("Control+s")
        page.wait_for_timeout(400)
        shot(page, "11_save_menu")
        page.keyboard.press("Escape")

        # 12. 줌 동작 (1 = 100%)
        print("\n[12] 100% 줌")
        page.keyboard.press("1")
        page.wait_for_timeout(300)
        shot(page, "12_zoom_100")

        # 13. FIT으로 복귀
        page.keyboard.press("0")
        page.wait_for_timeout(300)

        # 14. 사이드바 접기
        print("\n[13] 사이드바 토글")
        page.click("#btn-toggle")
        page.wait_for_timeout(300)
        shot(page, "13_sidebar_collapsed")

        # 결과 정리
        print("\n--- 콘솔 로그 ---")
        for m in console_msgs:
            print(m)
        if not console_msgs:
            print("  (콘솔 로그/에러 없음)")

        browser.close()
        print(f"\n스크린샷 저장 위치: {SHOTS}")
        print(f"총 {len(list(SHOTS.glob('*.png')))}장")


if __name__ == "__main__":
    main()
