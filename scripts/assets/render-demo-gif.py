"""Render the README demo GIF.

Requires Pillow. The generated asset is documentation-only and is not part of
the npm package.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1200
HEIGHT = 675
BACKGROUND = "#08090a"
PANEL = "#0d0f10"
PANEL_ALT = "#111416"
LINE = "#282b2d"
TEXT = "#f2f1ec"
MUTED = "#9ca1a4"
STEEL = "#666c6f"
ORANGE = "#ff5a1f"
ORANGE_DARK = "#25130d"

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "assets" / "slim-guard-demo.gif"


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    fonts = Path("C:/Windows/Fonts")
    candidates = {
        "regular": ["segoeui.ttf", "arial.ttf"],
        "semibold": ["seguisb.ttf", "arialbd.ttf"],
        "mono": ["consola.ttf", "cour.ttf"],
    }
    for candidate in candidates[name]:
        path = fonts / candidate
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


REGULAR = font("regular", 30)
SMALL = font("regular", 22)
TINY = font("regular", 17)
SEMIBOLD = font("semibold", 31)
TITLE = font("semibold", 51)
METRIC = font("semibold", 48)
MONO = font("mono", 22)
MONO_SMALL = font("mono", 18)


def rounded(draw: ImageDraw.ImageDraw, box, radius=18, fill=PANEL, outline=LINE, width=2):
    draw.rectangle(box, fill=fill, outline=outline, width=width)


def draw_mark(draw: ImageDraw.ImageDraw, x: int, y: int, scale: float = 1.0):
    def point(px, py):
        return (x + int(px * scale), y + int(py * scale))

    stroke = max(3, int(6 * scale))
    center = point(55, 36)
    draw.line([point(0, 2), point(22, 2), center], fill=STEEL, width=stroke)
    draw.line([point(0, 36), point(34, 36)], fill=STEEL, width=stroke)
    draw.line([point(0, 70), point(22, 70), center], fill=STEEL, width=stroke)
    draw.line([point(67, 36), point(96, 36)], fill=ORANGE, width=stroke)
    radius = max(5, int(8 * scale))
    draw.rectangle(
        (center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius),
        fill=ORANGE,
    )


def base(step: int, title: str, subtitle: str):
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw_mark(draw, 54, 35, 0.65)
    draw.text((135, 43), "SLIM GUARD", font=SEMIBOLD, fill=TEXT)
    draw.text((1090, 49), f"{step}/6", font=SMALL, fill=MUTED, anchor="ra")
    draw.text((54, 126), title, font=TITLE, fill=TEXT)
    draw.text((56, 194), subtitle, font=REGULAR, fill=MUTED)
    return image, draw


def pill(draw, box, label, fill=PANEL_ALT, outline=LINE, color=TEXT, text_font=MONO_SMALL):
    rounded(draw, box, radius=13, fill=fill, outline=outline, width=2)
    x1, y1, x2, y2 = box
    draw.text(
        ((x1 + x2) / 2, (y1 + y2) / 2),
        label,
        font=text_font,
        fill=color,
        anchor="mm",
    )


frames = []


image, draw = base(
    1,
    "MCP context grows before the task starts",
    "Large catalogs make every turn pay for tool definitions.",
)
tool_names = [
    "search_code",
    "list_files",
    "read_issue",
    "query_db",
    "get_logs",
    "fetch_url",
    "create_pr",
    "read_file",
    "list_runs",
    "get_schema",
    "search_docs",
    "get_report",
]
for index, name in enumerate(tool_names):
    row, column = divmod(index, 4)
    x = 55 + column * 278
    y = 285 + row * 82
    pill(draw, (x, y, x + 244, y + 54), name)
draw.text((55, 565), "12 upstream tools", font=METRIC, fill=TEXT)
draw.text((475, 579), "loaded into the agent context", font=REGULAR, fill=MUTED)
frames.append(image)


image, draw = base(
    2,
    "Compress the MCP surface to three tools",
    "Discovery stays available without exposing the full catalog on every turn.",
)
for index in range(12):
    row, column = divmod(index, 3)
    x = 55 + column * 115
    y = 282 + row * 66
    pill(draw, (x, y, x + 96, y + 40), f"tool_{index + 1:02}", text_font=TINY)
draw_mark(draw, 470, 350, 1.35)
draw.line((640, 398, 748, 398), fill=ORANGE, width=8)
draw.polygon([(748, 398), (727, 384), (727, 412)], fill=ORANGE)
for index, name in enumerate(["find_tool", "call_tool", "read_result"]):
    y = 300 + index * 88
    pill(
        draw,
        (800, y, 1135, y + 60),
        name,
        fill=ORANGE_DARK,
        outline=ORANGE,
        color=ORANGE,
        text_font=MONO,
    )
draw.text((55, 581), "12", font=METRIC, fill=TEXT)
draw.text((123, 593), "authorized tools", font=SMALL, fill=MUTED)
draw.text((800, 581), "3", font=METRIC, fill=ORANGE)
draw.text((848, 593), "agent-facing tools", font=SMALL, fill=MUTED)
frames.append(image)


image, draw = base(
    3,
    "The selected tool still runs once",
    "Slim Guard forwards the catalog-bound route and argument object unchanged.",
)
rounded(draw, (55, 294, 310, 488), fill=PANEL_ALT)
draw.text((182, 335), "AGENT", font=SEMIBOLD, fill=TEXT, anchor="mm")
pill(draw, (90, 383, 275, 438), "call_tool", fill=ORANGE_DARK, outline=ORANGE, color=ORANGE)
draw.line((310, 391, 444, 391), fill=STEEL, width=7)
draw.polygon([(444, 391), (423, 377), (423, 405)], fill=STEEL)
rounded(draw, (444, 276, 755, 506), fill=PANEL)
draw_mark(draw, 548, 304, 0.85)
draw.text((600, 407), "Slim Guard", font=SEMIBOLD, fill=TEXT, anchor="mm")
draw.text((600, 451), "arguments unchanged", font=SMALL, fill=ORANGE, anchor="mm")
draw.line((755, 391, 890, 391), fill=ORANGE, width=7)
draw.polygon([(890, 391), (869, 377), (869, 405)], fill=ORANGE)
rounded(draw, (890, 294, 1145, 488), fill=PANEL_ALT)
draw.text((1018, 345), "UPSTREAM", font=SEMIBOLD, fill=TEXT, anchor="mm")
draw.text((1018, 398), "MCP Server", font=REGULAR, fill=MUTED, anchor="mm")
pill(draw, (948, 428, 1088, 474), "call × 1", fill=ORANGE_DARK, outline=ORANGE, color=ORANGE)
frames.append(image)


image, draw = base(
    4,
    "Large results arrive as a compact capsule",
    "The model gets useful boundaries now and an exact recovery reference.",
)
rounded(draw, (55, 274, 486, 524), fill=PANEL_ALT)
draw.text((89, 309), "CallToolResult", font=SEMIBOLD, fill=TEXT)
draw.text((89, 364), "73,507 characters", font=METRIC, fill=STEEL)
for y, length in [(433, 325), (462, 270), (491, 304)]:
    draw.rounded_rectangle((90, y, 90 + length, y + 10), radius=5, fill=LINE)
draw.line((486, 399, 607, 399), fill=ORANGE, width=7)
draw.polygon([(607, 399), (586, 385), (586, 413)], fill=ORANGE)
rounded(draw, (607, 274, 1145, 524), fill=PANEL, outline=ORANGE)
draw.text((643, 309), "projection: head-tail-v1", font=MONO_SMALL, fill=ORANGE)
draw.text((643, 355), "Beginning of the report …", font=SMALL, fill=TEXT)
draw.text((643, 392), "[71,107 chars omitted]", font=SMALL, fill=MUTED)
draw.text((643, 429), "… final status and marker", font=SMALL, fill=TEXT)
pill(
    draw,
    (643, 466, 1086, 510),
    "result_ref: rs_7a…",
    fill=ORANGE_DARK,
    outline=ORANGE,
    color=ORANGE,
)
frames.append(image)


image, draw = base(
    5,
    "Recover exact content without rerunning the tool",
    "read_result reads the stored snapshot. The upstream counter stays at one.",
)
pill(
    draw,
    (55, 312, 355, 383),
    "read_result",
    fill=ORANGE_DARK,
    outline=ORANGE,
    color=ORANGE,
    text_font=MONO,
)
draw.text((205, 431), "result_ref + cursor", font=SMALL, fill=MUTED, anchor="mm")
draw.line((355, 348, 505, 348), fill=ORANGE, width=7)
draw.polygon([(505, 348), (484, 334), (484, 362)], fill=ORANGE)
rounded(draw, (505, 278, 1145, 518), fill=PANEL_ALT)
draw.text((543, 316), "EXACT SNAPSHOT", font=SEMIBOLD, fill=TEXT)
for index, width in enumerate([500, 462, 527, 401]):
    y = 378 + index * 30
    draw.rounded_rectangle((544, y, 544 + width, y + 10), radius=5, fill=STEEL)
pill(
    draw,
    (785, 542, 1145, 596),
    "upstream calls: 1",
    fill=ORANGE_DARK,
    outline=ORANGE,
    color=ORANGE,
    text_font=MONO,
)
frames.append(image)


image, draw = base(
    6,
    "24 tasks. 24 upstream calls.",
    "Compression changes what the agent sees, not what the tool does.",
)
rounded(draw, (55, 282, 1145, 486), fill=PANEL, outline=LINE)
draw.text((98, 325), "NORMAL-PATH TOKENS", font=SMALL, fill=MUTED)
draw.text((98, 381), "71,388", font=METRIC, fill=TEXT)
draw.text((302, 392), "→", font=METRIC, fill=STEEL)
draw.text((400, 381), "18,385", font=METRIC, fill=ORANGE)
draw.text((765, 340), "24/24 tasks", font=SEMIBOLD, fill=ORANGE)
draw.text((765, 395), "24 calls", font=SEMIBOLD, fill=ORANGE)
draw.text((55, 544), "Frozen 12-tool bilingual fixture · o200k_base · no model or API calls", font=SMALL, fill=MUTED)
draw.text((55, 589), "Fixture-bound result, not a universal savings rate.", font=SMALL, fill=MUTED)
frames.append(image)


durations = [2200, 2300, 2500, 2300, 2500, 3200]
frames[0].save(
    OUTPUT,
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=2,
)
print(OUTPUT)
