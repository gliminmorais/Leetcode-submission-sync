"""Generate the README architecture diagram and the toolbar's PNG icons."""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
from matplotlib import pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch


ROOT = Path(__file__).resolve().parents[1]
PAPER, INK, MUTED = "#f6f4ed", "#202924", "#4d5e53"
GREEN, PALE, LINE = "#25563b", "#e4ede1", "#a9baaa"


def architecture():
    fig = plt.figure(figsize=(12, 6.2), facecolor=PAPER)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set(xlim=(0, 120), ylim=(0, 62))
    ax.axis("off")

    def caption(x, y, text, **kwargs):
        settings = {"color": INK, "va": "center", "fontfamily": "DejaVu Sans"}
        ax.text(x, y, text, **(settings | kwargs))

    def frame(x, y, w, h, fill=PAPER, edge=LINE):
        ax.add_patch(FancyBboxPatch(
            (x, y), w, h, boxstyle="round,pad=0,rounding_size=1.1",
            linewidth=1, edgecolor=edge, facecolor=fill
        ))

    def card(x, y, w, h, title, body, fill="#fffdf7"):
        frame(x, y, w, h, fill)
        caption(x + 2.1, y + h - 3.1, title, fontsize=12, fontweight="bold")
        caption(x + 2.1, y + h - 6, body, fontsize=9.3, va="top", color=MUTED, linespacing=1.35)

    def arrow(x1, y1, x2, y2):
        ax.add_patch(FancyArrowPatch(
            (x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=12,
            linewidth=1.45, color=GREEN, shrinkA=1, shrinkB=1
        ))

    caption(4, 57, "From Accepted to committed", fontsize=24, fontweight="bold")
    caption(4, 52.8, "Verdict Sync  /  Chrome or Brave  /  Manifest V3",
            fontsize=11, color=MUTED)

    frame(4, 20, 51, 28.3, PALE)
    frame(59, 20, 36, 28.3, PALE)
    caption(6.4, 45.5, "LEETCODE TAB", fontsize=10, fontweight="bold", color=GREEN)
    caption(61.5, 45.5, "EXTENSION", fontsize=10, fontweight="bold", color=GREEN)

    card(6.4, 31.5, 20.9, 11.1, "Submit observer", "MAIN world\nReceives submission ID")
    card(30.7, 31.5, 21.9, 11.1, "Result relay", "Isolated world\nChecks verdict + source")
    card(61.5, 31.5, 31, 11.1, "Service worker", "Queues accepted code and builds\nsolution, README, and stats")
    card(99, 31.5, 17.4, 11.1, "GitHub", "Topic folders\nOne commit")
    arrow(27.3, 37, 30.7, 37)
    arrow(52.6, 37, 61.5, 37)
    arrow(92.5, 37, 99, 37)

    caption(9, 25.7, "Click Submit", fontsize=10, color=GREEN, fontweight="bold")
    caption(31, 25.7, "Accepted only", fontsize=10, color=GREEN, fontweight="bold")
    caption(63, 25.7, "Persisted queue  ·  retry on failure",
            fontsize=10, color=GREEN, fontweight="bold")
    arrow(77, 16.2, 77, 20)
    card(59, 4.7, 36, 11.4, "Toolbar popup", "Connect GitHub, choose repo,\nand turn auto-sync on or off")

    ax.plot([4, 53], [13.6, 13.6], color=LINE, linewidth=1)
    caption(4, 10.2, "Submission ID → verified code → atomic commit",
            fontsize=10, color=MUTED)
    caption(4, 6.9, "Token stored locally and sent only to GitHub.",
            fontsize=10, color=MUTED)

    directory = ROOT / "docs"
    directory.mkdir(exist_ok=True)
    fig.savefig(directory / "architecture.png", dpi=165, facecolor=PAPER)
    plt.close(fig)


def icons():
    directory = ROOT / "extension" / "icons"
    directory.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        fig = plt.figure(figsize=(1, 1), dpi=size)
        ax = fig.add_axes([0, 0, 1, 1])
        ax.set(xlim=(0, 32), ylim=(0, 32))
        ax.axis("off")
        ax.add_patch(FancyBboxPatch(
            (1, 1), 30, 30, boxstyle="round,pad=0,rounding_size=7",
            facecolor="#c7e4bd", edgecolor="none"
        ))
        ax.plot([8.5, 13.8, 23.6], [16.1, 10.8, 21.8], color="#203b2c",
                linewidth=7, solid_capstyle="round", solid_joinstyle="round")
        fig.savefig(directory / f"{size}.png", dpi=size, transparent=True)
        plt.close(fig)


if __name__ == "__main__":
    architecture()
    icons()
