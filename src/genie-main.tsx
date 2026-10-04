import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Overlay that plays the macOS "genie" effect for application windows.
// Rust sends a snapshot of the window plus the source rect (the window) and the
// target rect (its dock icon), all in CSS pixels relative to this window.

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface PlayPayload {
	kind: "minimize" | "restore" | "open" | "close";
	image: string;
	from: Rect;
	to: Rect;
	duration: number;
}

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
let raf = 0;
let runId = 0;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

function resizeCanvas() {
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(window.innerWidth * dpr);
	canvas.height = Math.round(window.innerHeight * dpr);
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function clear() {
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	const dpr = window.devicePixelRatio || 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Draws the window sucked towards (s = 1) or released from (s = 0) its icon.
 * The bottom of the window leads, so the sides bend into the classic genie
 * funnel.
 */
function drawGenie(img: HTMLImageElement, from: Rect, to: Rect, s: number) {
	const strips = Math.max(40, Math.min(220, Math.ceil(from.h / 3)));
	const xs: number[] = [];
	const ys: number[] = [];
	const ws: number[] = [];
	const cx0 = from.x + from.w / 2;
	const cx1 = to.x + to.w / 2;
	const narrow = Math.max(10, to.w * 0.9);

	for (let i = 0; i <= strips; i++) {
		const v = i / strips; // 0 = top of the window, 1 = bottom
		const k = clamp01(s * 1.75 - (1 - v) * 0.75);
		const e = easeInOutCubic(k);
		const y = lerp(from.y + v * from.h, to.y + to.h * (0.25 + 0.5 * v), e);
		const w = lerp(from.w, narrow, Math.pow(e, 0.85));
		const cx = lerp(cx0, cx1, easeInOutSine(e));
		ys.push(y);
		ws.push(w);
		xs.push(cx - w / 2);
	}

	const srcStripH = img.naturalHeight / strips;
	for (let i = 0; i < strips; i++) {
		const dy = ys[i];
		const dh = Math.max(1, ys[i + 1] - ys[i]) + 1;
		ctx.drawImage(img, 0, i * srcStripH, img.naturalWidth, srcStripH + 0.5, xs[i], dy, ws[i], dh);
	}
}

function drawClose(img: HTMLImageElement, from: Rect, t: number) {
	const e = easeInOutSine(t);
	const scale = lerp(1, 0.86, e);
	const w = from.w * scale;
	const h = from.h * scale;
	ctx.drawImage(img, from.x + (from.w - w) / 2, from.y + (from.h - h) / 2, w, h);
}

async function play(p: PlayPayload) {
	const id = ++runId;
	cancelAnimationFrame(raf);
	resizeCanvas();
	clear();

	const img = new Image();
	img.src = p.image;
	try {
		await img.decode();
	} catch {
		await invoke("genie_reveal").catch(() => {});
		await invoke("genie_done").catch(() => {});
		return;
	}
	if (id !== runId) return;

	const start = performance.now();
	const reverse = p.kind === "restore" || p.kind === "open";

	const frame = (now: number) => {
		if (id !== runId) return;
		const t = clamp01((now - start) / p.duration);
		clear();
		if (p.kind === "close") {
			ctx.globalAlpha = 1 - easeInOutSine(t);
			drawClose(img, p.from, t);
		} else {
			const eased = easeInOutSine(t);
			const s = reverse ? 1 - eased : eased;
			// Fade only the very end when sucking in / the very start when emerging.
			const alphaT = reverse ? clamp01(t / 0.15) : 1 - clamp01((t - 0.88) / 0.12);
			ctx.globalAlpha = alphaT;
			drawGenie(img, p.from, p.to, s);
		}
		ctx.globalAlpha = 1;

		if (t < 1) {
			raf = requestAnimationFrame(frame);
		} else {
			finish(id, reverse);
		}
	};
	raf = requestAnimationFrame(frame);
}

async function finish(id: number, reveal: boolean) {
	if (reveal) {
		// Show the real window first, then drop the overlay a moment later so
		// there is no flash between the two.
		await invoke("genie_reveal").catch(() => {});
		await new Promise((r) => setTimeout(r, 90));
	}
	if (id !== runId) return;
	clear();
	await invoke("genie_done").catch(() => {});
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

listen<PlayPayload>("genie-play", (event) => {
	play(event.payload);
});

invoke("genie_ready").catch(() => {});
