import os
import threading
import tkinter as tk
from tkinter import filedialog, ttk

import numpy as np
from PIL import Image, ImageTk

try:
    RESAMPLE = Image.Resampling.LANCZOS
except AttributeError:
    RESAMPLE = Image.LANCZOS


GRID_SIZES = [48, 64, 128, 256]
GRID_COLOR = "#000000"
CANVAS_BG = "#1e1e1e"
CHECKER_TILE = 10
CHECKER_LIGHT = (220, 220, 220, 255)
CHECKER_DARK = (170, 170, 170, 255)


def pixelize(src: Image.Image, n: int) -> Image.Image:
    """N×N 격자로 다운샘플. 한 칸에 알파>0 픽셀이 1개라도 있으면 그 칸은
    알파 픽셀들의 평균 RGB로 채우고 알파=255, 없으면 투명."""
    if src.mode != "RGBA":
        src = src.convert("RGBA")
    arr = np.asarray(src)  # (H, W, 4)
    h, w = arr.shape[:2]
    new_h = (h // n) * n
    new_w = (w // n) * n
    if new_h == 0 or new_w == 0:
        return src.resize((n, n), Image.NEAREST)
    arr = arr[:new_h, :new_w]
    cell_h = new_h // n
    cell_w = new_w // n
    blocks = arr.reshape(n, cell_h, n, cell_w, 4).swapaxes(1, 2)  # (n, n, ch, cw, 4)

    alpha = blocks[..., 3]
    mask = alpha > 0  # (n, n, ch, cw)
    counts = mask.sum(axis=(2, 3))  # (n, n)

    rgb = blocks[..., :3].astype(np.int32)
    rgb_sum = (rgb * mask[..., None]).sum(axis=(2, 3))  # (n, n, 3)
    safe_counts = np.maximum(counts, 1)[..., None]
    rgb_avg = (rgb_sum // safe_counts).astype(np.uint8)

    has_any = counts > 0
    out_alpha = np.where(has_any, 255, 0).astype(np.uint8)
    out_rgb = np.where(has_any[..., None], rgb_avg, 0).astype(np.uint8)
    out = np.concatenate([out_rgb, out_alpha[..., None]], axis=-1)
    return Image.fromarray(out, "RGBA")


def quantize_colors(img: Image.Image, n_colors: int) -> Image.Image:
    """RGBA 이미지를 n색 팔레트로 양자화. 알파 채널은 그대로 유지."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    alpha = img.getchannel("A")
    rgb = img.convert("RGB")
    quantized = rgb.quantize(
        colors=n_colors,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    ).convert("RGB")
    quantized.putalpha(alpha)
    return quantized


def make_checker(w: int, h: int) -> Image.Image:
    base = Image.new("RGBA", (2, 2))
    base.putpixel((0, 0), CHECKER_LIGHT)
    base.putpixel((1, 1), CHECKER_LIGHT)
    base.putpixel((0, 1), CHECKER_DARK)
    base.putpixel((1, 0), CHECKER_DARK)
    tile = base.resize((CHECKER_TILE * 2, CHECKER_TILE * 2), Image.NEAREST)
    full = Image.new("RGBA", (w, h))
    for y in range(0, h, CHECKER_TILE * 2):
        for x in range(0, w, CHECKER_TILE * 2):
            full.paste(tile, (x, y))
    return full


class CustomNotebook(ttk.Notebook):
    """탭마다 닫기(X) 버튼이 달린 Notebook."""

    _initialized = False

    def __init__(self, *args, **kwargs):
        if not CustomNotebook._initialized:
            self._setup_style()
            CustomNotebook._initialized = True
        kwargs["style"] = "CustomNotebook"
        super().__init__(*args, **kwargs)

        self._active_close = None
        self.bind("<ButtonPress-1>", self._on_close_press, True)
        self.bind("<ButtonRelease-1>", self._on_close_release)

    def _on_close_press(self, event):
        element = self.identify(event.x, event.y)
        if "close" in element:
            try:
                index = self.index(f"@{event.x},{event.y}")
            except tk.TclError:
                return
            self.state(["pressed"])
            self._active_close = index
            return "break"

    def _on_close_release(self, event):
        if not self.instate(["pressed"]):
            return
        element = self.identify(event.x, event.y)
        try:
            index = self.index(f"@{event.x},{event.y}")
        except tk.TclError:
            self.state(["!pressed"])
            self._active_close = None
            return
        if "close" in element and self._active_close == index:
            self.forget(index)
            self.event_generate("<<NotebookTabClosed>>")
        self.state(["!pressed"])
        self._active_close = None

    def _setup_style(self):
        style = ttk.Style()
        self._images = (
            tk.PhotoImage(
                "img_close",
                data=(
                    "R0lGODlhCAAIAMIBAAAAADs7O4+Pj9nZ2Ts7Ozs7Ozs7Ozs7OyH+EUNyZWF0ZWQg"
                    "d2l0aCBHSU1QACH5BAEKAAQALAAAAAAIAAgAAAMVGDBEA0qNJyGw7AmxmuaZhWEU"
                    "5kEJADs="
                ),
            ),
            tk.PhotoImage(
                "img_closeactive",
                data=(
                    "R0lGODlhCAAIAMIEAAAAAP/SAP/bNNnZ2cbGxsbGxsbGxsbGxiH5BAEKAAQALAAA"
                    "AAAIAAgAAAMVGDBEA0qNJyGw7AmxmuaZhWEU5kEJADs="
                ),
            ),
            tk.PhotoImage(
                "img_closepressed",
                data=(
                    "R0lGODlhCAAIAMIEAAAAAOUqKv9mZtnZ2Ts7Ozs7Ozs7Ozs7OyH+EUNyZWF0ZWQg"
                    "d2l0aCBHSU1QACH5BAEKAAQALAAAAAAIAAgAAAMVGDBEA0qNJyGw7AmxmuaZhWEU"
                    "5kEJADs="
                ),
            ),
        )
        try:
            style.element_create(
                "close",
                "image",
                "img_close",
                ("active", "pressed", "!disabled", "img_closepressed"),
                ("active", "!disabled", "img_closeactive"),
                border=8,
                sticky="",
            )
        except tk.TclError:
            return
        style.layout(
            "CustomNotebook",
            [("CustomNotebook.client", {"sticky": "nswe"})],
        )
        style.layout(
            "CustomNotebook.Tab",
            [
                (
                    "CustomNotebook.tab",
                    {
                        "sticky": "nswe",
                        "children": [
                            (
                                "CustomNotebook.padding",
                                {
                                    "side": "top",
                                    "sticky": "nswe",
                                    "children": [
                                        (
                                            "CustomNotebook.focus",
                                            {
                                                "side": "top",
                                                "sticky": "nswe",
                                                "children": [
                                                    (
                                                        "CustomNotebook.label",
                                                        {"side": "left", "sticky": ""},
                                                    ),
                                                    (
                                                        "CustomNotebook.close",
                                                        {"side": "left", "sticky": ""},
                                                    ),
                                                ],
                                            },
                                        )
                                    ],
                                },
                            )
                        ],
                    },
                )
            ],
        )


class ImageTab:
    def __init__(
        self,
        parent: ttk.Notebook,
        app: "PixelMotionApp",
        name: str,
        image: Image.Image,
    ) -> None:
        self.app = app
        self.name = name
        self.original: Image.Image = image
        self.source: Image.Image = image
        self.is_pixelized: bool = False
        self.tk_image: ImageTk.PhotoImage | None = None
        self._last_size: tuple[int, int] = (0, 0)

        self.frame = ttk.Frame(parent)
        self.canvas = tk.Canvas(self.frame, bg=CANVAS_BG, highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind("<Configure>", self._on_canvas_configure)

    def _on_canvas_configure(self, event: tk.Event) -> None:
        size = (event.width, event.height)
        if size == self._last_size:
            return
        self._last_size = size
        self.redraw()

    def redraw(self) -> None:
        self.canvas.delete("all")
        cw = self.canvas.winfo_width()
        ch = self.canvas.winfo_height()
        if cw <= 1 or ch <= 1:
            return

        iw, ih = self.source.size
        if self.is_pixelized:
            pixel_size = max(1, min(int(cw * 0.95) // iw, int(ch * 0.95) // ih))
            dw = iw * pixel_size
            dh = ih * pixel_size
            resample = Image.NEAREST
        else:
            scale = min(cw / iw, ch / ih) * 0.95
            dw = max(1, int(iw * scale))
            dh = max(1, int(ih * scale))
            resample = RESAMPLE
        x = (cw - dw) // 2
        y = (ch - dh) // 2

        scaled = self.source.resize((dw, dh), resample)
        checker = make_checker(dw, dh)
        composited = Image.alpha_composite(checker, scaled)

        self.tk_image = ImageTk.PhotoImage(composited)
        self.canvas.create_image(x, y, anchor=tk.NW, image=self.tk_image)

        if self.app.show_grid.get():
            self._draw_grid(x, y, dw, dh)

        self._draw_size_badge(iw, ih)
        self.app.update_status(f"{self.name}  |  {iw} × {ih} px")

    def _draw_grid(self, x: int, y: int, w: int, h: int) -> None:
        n = self.app.grid_size.get()
        for i in range(n + 1):
            gx = x + w * i / n
            self.canvas.create_line(gx, y, gx, y + h, fill=GRID_COLOR, width=1)
        for j in range(n + 1):
            gy = y + h * j / n
            self.canvas.create_line(x, gy, x + w, gy, fill=GRID_COLOR, width=1)

    def _draw_size_badge(self, w: int, h: int) -> None:
        text = f"{w} × {h} px"
        pad_x, pad_y = 12, 8
        x0, y0 = 12, 12
        text_id = self.canvas.create_text(
            x0 + pad_x,
            y0 + pad_y,
            text=text,
            anchor=tk.NW,
            fill="#00ff88",
            font=("Consolas", 12, "bold"),
        )
        bbox = self.canvas.bbox(text_id)
        if bbox is not None:
            x1, y1, x2, y2 = bbox
            rect_id = self.canvas.create_rectangle(
                x1 - pad_x,
                y1 - pad_y,
                x2 + pad_x,
                y2 + pad_y,
                fill="#000000",
                outline="#00ff88",
                width=1,
            )
            self.canvas.tag_lower(rect_id, text_id)


class PixelMotionApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("PixelMotion")
        self.root.geometry("1024x720")

        self.grid_size = tk.IntVar(value=64)
        self.show_grid = tk.BooleanVar(value=True)
        self.color_limit = tk.IntVar(value=0)  # 0 = 제한 없음
        self._tabs: list[ImageTab] = []

        self._build_ui()

    def _build_ui(self) -> None:
        toolbar = ttk.Frame(self.root, padding=8)
        toolbar.pack(fill=tk.X, side=tk.TOP)

        ttk.Button(toolbar, text="이미지 열기", command=self.open_image).pack(side=tk.LEFT)
        self.bg_button = ttk.Button(
            toolbar, text="배경 제거", command=self.remove_background
        )
        self.bg_button.pack(side=tk.LEFT, padx=(8, 0))

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=12)

        ttk.Label(toolbar, text="격자:").pack(side=tk.LEFT, padx=(0, 6))
        for size in GRID_SIZES:
            ttk.Radiobutton(
                toolbar,
                text=f"{size}×{size}",
                value=size,
                variable=self.grid_size,
                command=self._on_grid_size_change,
            ).pack(side=tk.LEFT, padx=2)

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=12)

        ttk.Checkbutton(
            toolbar,
            text="격자 표시",
            variable=self.show_grid,
            command=self._refresh_current,
        ).pack(side=tk.LEFT)

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=12)

        ttk.Label(toolbar, text="색:").pack(side=tk.LEFT, padx=(0, 6))
        for c, label in [(0, "원본"), (8, "8"), (16, "16"), (32, "32"), (64, "64")]:
            ttk.Radiobutton(
                toolbar,
                text=label,
                value=c,
                variable=self.color_limit,
                command=self._on_color_limit_change,
            ).pack(side=tk.LEFT, padx=2)

        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=12)

        ttk.Button(toolbar, text="도트화", command=self.pixelize_current).pack(side=tk.LEFT)

        self.status = ttk.Label(toolbar, text="이미지를 열어주세요", anchor=tk.E)
        self.status.pack(side=tk.RIGHT, fill=tk.X, expand=True)

        self.notebook = CustomNotebook(self.root)
        self.notebook.pack(fill=tk.BOTH, expand=True)
        self.notebook.bind("<<NotebookTabClosed>>", self._on_tab_closed)
        self.notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)

    def open_image(self) -> None:
        path = filedialog.askopenfilename(
            title="이미지 선택",
            filetypes=[
                ("이미지 파일", "*.png *.jpg *.jpeg *.bmp *.gif *.webp"),
                ("모든 파일", "*.*"),
            ],
        )
        if not path:
            return
        try:
            img = Image.open(path).convert("RGBA")
        except Exception as e:
            self.update_status(f"열기 실패: {e}")
            return
        name = os.path.basename(path)
        tab = ImageTab(self.notebook, self, name, img)
        self.notebook.add(tab.frame, text=f"{name}  ")
        self.notebook.select(tab.frame)
        self._tabs.append(tab)

    def _current_tab(self) -> ImageTab | None:
        try:
            sel = self.notebook.select()
        except tk.TclError:
            return None
        if not sel:
            return None
        for t in self._tabs:
            if str(t.frame) == sel:
                return t
        return None

    def _refresh_current(self) -> None:
        t = self._current_tab()
        if t:
            t.redraw()

    def _on_tab_changed(self, event: tk.Event) -> None:
        t = self._current_tab()
        if t:
            t.redraw()
        else:
            self.update_status("이미지를 열어주세요")

    def _on_tab_closed(self, event: tk.Event) -> None:
        existing = set(self.notebook.tabs())
        self._tabs = [t for t in self._tabs if str(t.frame) in existing]
        if not self._tabs:
            self.update_status("이미지를 열어주세요")

    def pixelize_current(self) -> None:
        t = self._current_tab()
        if t is None:
            self.update_status("이미지를 먼저 열어주세요")
            return
        self._apply_pixelize(t)

    def _apply_pixelize(self, tab: ImageTab) -> None:
        n = self.grid_size.get()
        c = self.color_limit.get()
        try:
            result = pixelize(tab.original, n)
            if c > 0:
                result = quantize_colors(result, c)
        except Exception as e:
            self.update_status(f"도트화 실패: {e}")
            return
        tab.source = result
        tab.is_pixelized = True
        tab.redraw()

    def _on_grid_size_change(self) -> None:
        t = self._current_tab()
        if t is None:
            return
        if t.is_pixelized:
            self._apply_pixelize(t)
        else:
            t.redraw()

    def _on_color_limit_change(self) -> None:
        t = self._current_tab()
        if t is None:
            return
        if t.is_pixelized:
            self._apply_pixelize(t)

    def remove_background(self) -> None:
        t = self._current_tab()
        if t is None:
            self.update_status("이미지를 먼저 열어주세요")
            return
        self.bg_button.config(state=tk.DISABLED)
        self.update_status("배경 제거 중... (첫 실행 시 모델 다운로드 ~170MB)")
        img = t.source.copy()
        threading.Thread(target=self._bg_worker, args=(t, img), daemon=True).start()

    def _bg_worker(self, tab: ImageTab, img: Image.Image) -> None:
        try:
            from rembg import remove
            result = remove(img)
            if result.mode != "RGBA":
                result = result.convert("RGBA")
            self.root.after(0, lambda: self._on_bg_done(tab, result))
        except Exception as e:
            msg = str(e)
            self.root.after(0, lambda: self._on_bg_error(msg))

    def _on_bg_done(self, tab: ImageTab, result: Image.Image) -> None:
        tab.original = result
        tab.source = result
        tab.is_pixelized = False
        self.bg_button.config(state=tk.NORMAL)
        if self._current_tab() is tab:
            tab.redraw()
        else:
            self.update_status("배경 제거 완료 (다른 탭)")

    def _on_bg_error(self, msg: str) -> None:
        self.bg_button.config(state=tk.NORMAL)
        self.update_status(f"배경 제거 실패: {msg}")

    def update_status(self, text: str) -> None:
        self.status.config(text=text)


def main() -> None:
    root = tk.Tk()
    PixelMotionApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
