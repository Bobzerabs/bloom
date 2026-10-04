import { useT, translate } from "./i18n";
import { useState, useEffect, useMemo, useRef, memo, type ReactElement } from "react";
import { motion, AnimatePresence, Reorder } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./Dock.css";
import { initTheme } from "./theme";
import { useSettingsSync } from "./hooks/useSettingsSync";

interface AppInfo {
	name: string;
	path: string;
	icon: string | null;
	is_running: boolean;
	is_pinned?: boolean;
	hwnd?: number;
	executable?: string;
	all_hwnds?: [number, string][];
}

// Host processes (Edge/Chrome/Brave/ApplicationFrameHost) run every PWA/UWP
// window, so their window title must be part of their identity — otherwise two
// PWAs running under the same browser collapse into a single dock item.
const HOST_PROCESSES = ["msedge.exe", "chrome.exe", "brave.exe", "applicationframehost.exe"];
export function isBrowserHost(path: string) {
	const p = path.toLowerCase();
	return HOST_PROCESSES.some((host) => p.includes(host));
}

// Stable identity for a dock item.
export function appIdentity(p: string, executable?: string, name?: string) {
	if (!p) return "";
	const normalized = p.toLowerCase().replace(/\\/g, "/");
	// Shell application ids (AUMIDs) and bare names are unique on their own.
	if (!normalized.includes("/")) return normalized;
	if (name && isBrowserHost(normalized)) {
		return `${normalized}:${name.toLowerCase()}`;
	}
	if (executable) return `${normalized}:${executable.toLowerCase()}`;
	return normalized;
}

const itemKey = (app: AppInfo) => appIdentity(app.path, app.executable, app.name);

// Shell application ids (AUMIDs) identify one specific app; two different PWAs
// running in the same browser must never be matched by their shared exe name.
const isIdentifier = (p: string) => !p.includes("/") && !p.includes("\\");

// Resolve the configured start-button icon to a public asset, or to the data
// URI of a user-uploaded icon (stored with a "custom:" prefix).
function resolveStartIcon(startIcon: string): string {
	if (startIcon === "bloom-colorful") return "/bloom-colorful.png";
	if (startIcon === "bloom-golden") return "/bloom-golden.png";
	if (startIcon === "bloom-biscuit") return "/bloom-biscuit.png";
	if (startIcon === "windows") return "/windows.png";
	if (startIcon.startsWith("custom:")) return startIcon.slice("custom:".length);
	return "/bloom.png";
}

// Stable module-level constants so object references never change between renders,
// preventing Framer Motion from re-triggering animations on every re-render.
const ITEM_ENTRY_TRANSITION = {
	opacity: { duration: 0.15, delay: 0.15 },
	scale: { type: "spring" as const, stiffness: 400, damping: 25, delay: 0.15 }
};
const ITEM_INITIAL = { opacity: 0, scale: 0 };
const ITEM_ANIMATE = { opacity: 1, scale: 1 };
const ITEM_EXIT = { opacity: 0, scale: 0 };

// The dock page is also loaded in extra windows ("dock-m<N>") that show the dock
// on additional monitors. Those windows report their own hit-test regions.
const IS_SECONDARY_DOCK = (() => {
	try {
		return getCurrentWebviewWindow().label.startsWith("dock-m");
	} catch {
		return false;
	}
})();
const RECT_COMMAND = IS_SECONDARY_DOCK ? "update_secondary_dock_rect" : "update_dock_rect";
const MENU_COMMAND = IS_SECONDARY_DOCK ? "set_secondary_menu_open" : "set_menu_open";

const Dock = memo(function Dock() {
	const t = useT();
	useEffect(() => {
		return initTheme();
	}, []);

	const [pinnedApps, setPinnedApps] = useState<AppInfo[]>([]);
	const [activeApps, setActiveApps] = useState<AppInfo[]>([]);
	const iconsRef = useRef<Record<string, string>>({});
	const [, setIconsTick] = useState(0);
	const [dockMode, setDockMode] = useState(() => {
		const raw = localStorage.getItem("bloom-dock-mode") || "fixed";
		if (raw === "auto-hide") return "smart";
		return raw;
	});
	const [dockPreviewEnabled, setDockPreviewEnabled] = useState(
		() => localStorage.getItem("bloom-dock-preview-enabled") !== "false"
	);
	const [dockIconOnly, setDockIconOnly] = useState(
		() => localStorage.getItem("bloom-dock-icon-only") === "true"
	);
	const [dockAdaptive, setDockAdaptive] = useState(
		() => localStorage.getItem("bloom-dock-adaptive") === "true"
	);
	const [dockTrayEnabled, setDockTrayEnabled] = useState(
		() => localStorage.getItem("bloom-dock-tray-enabled") !== "false"
	);
	const [dockMagnify, setDockMagnify] = useState(
		() => localStorage.getItem("bloom-dock-magnify") !== "false"
	);
	const [dockMagnifySize, setDockMagnifySize] = useState(() => {
		const v = parseFloat(localStorage.getItem("bloom-dock-magnify-size") || "1.3");
		return isNaN(v) ? 1.3 : Math.min(Math.max(v, 1.1), 1.6);
	});
	const [dockOpenClose, setDockOpenClose] = useState(
		() => localStorage.getItem("bloom-dock-openclose-anim") === "true"
	);
	const [dockBounce, setDockBounce] = useState(
		() => localStorage.getItem("bloom-dock-bounce") !== "false"
	);
	const [bouncingApp, setBouncingApp] = useState<string | null>(null);
	const isDraggingRef = useRef(false);
	const scaleRef = useRef(1);
	const [startIcon, setStartIcon] = useState(
		() => localStorage.getItem("bloom-start-icon") || "default"
	);
	const [isMaximized, setIsMaximized] = useState(false);
	const [previewData, setPreviewData] = useState<{
		id: string;
		previews: { hwnd: number; title: string; image: string }[];
	} | null>(null);
	const [isDockHovered, setIsDockHovered] = useState(false);
	const [isEdgeHovered, setIsEdgeHovered] = useState(false);
	const [isOverlapped, setIsOverlapped] = useState(false);
	const [isVisible, setIsVisible] = useState(true);
	const [showAddPopup, setShowAddPopup] = useState(false);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		app: AppInfo | null;
	} | null>(null);
	const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
	const [activeOrder, setActiveOrder] = useState<string[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const [hoveredApp, setHoveredApp] = useState<string | null>(null);
	const [pressedApp, setPressedApp] = useState<string | null>(null);
	const [isReady, setIsReady] = useState(false);
	const [isImpacted, setIsImpacted] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [startupAnimating, setStartupAnimating] = useState(false);
	const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
	const [toast, setToast] = useState<string | null>(null);
	const iconPickerTargetRef = useRef<string | null>(null);
	const toastTimerRef = useRef<any>(null);
	const dockRef = useRef<HTMLDivElement>(null);
	const pinnedItemsRef = useRef<AppInfo[]>([]);
	const handleAppClickRef = useRef<(app: AppInfo) => void>(() => {});
	const [scale, setScale] = useState(() =>
		parseFloat(localStorage.getItem("bloom-scale") || "1.0")
	);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

	useEffect(() => {
		const onResize = () => setViewportWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const isCurrentlyHovered = isDockHovered || isEdgeHovered;
	const [interactionState, setInteractionState] = useState<"active" | "grace" | "none">("none");
	const isAnyInteraction = isCurrentlyHovered || !!contextMenu || showAddPopup;

	const previewTimerRef = useRef<any>(null);
	const isPreviewHoveredRef = useRef(false);
	const hoveredAppRef = useRef<string | null>(null);

	useEffect(() => {
		if (isAnyInteraction) {
			setInteractionState("active");
		} else if (interactionState !== "none") {
			setInteractionState("grace");
			const timer = setTimeout(() => setInteractionState("none"), 800);
			return () => clearTimeout(timer);
		}
	}, [isAnyInteraction]);

	const isHidden =
		!startupAnimating &&
		((dockMode === "smart" && isOverlapped && interactionState === "none") ||
			(dockMode === "peek" && interactionState === "none"));

	// Adaptive mode (fixed dock only): stretch into a full-width taskbar while a
	// standard maximized window is in the foreground, so the reserved strip no
	// longer looks like a cut-out around the centered pill.
	const isAdaptive =
		dockAdaptive && dockMode === "fixed" && isMaximized && isExpanded && !isHidden && isVisible;
	// Nearly full width — 24px margin per side at the visual (scaled) size.
	// Pre-transform: visual = width * scale, so width = (viewport - 48*scale) / scale.
	const adaptiveWidth = (viewportWidth - 48 * scale) / scale;

	useEffect(() => {
		let cleared = false;

		const checkVisibility = async (): Promise<boolean> => {
			try {
				const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
				const visible = await getCurrentWebviewWindow().isVisible();
				if (visible) {
					setStartupAnimating(true);
					setIsReady(true);
					setTimeout(() => setIsImpacted(true), 280);
					setTimeout(() => setIsExpanded(true), 350);
					setTimeout(() => setStartupAnimating(false), 1500);
					return true;
				}
			} catch (_) {}
			return false;
		};

		// Keep polling until visible — no time cap, since the dock can be
		// enabled at runtime from settings after any delay.
		const interval = setInterval(async () => {
			if (cleared) return;
			if (await checkVisibility()) {
				clearInterval(interval);
				cleared = true;
			}
		}, 200);

		// Also attempt immediately
		checkVisibility().then((ok) => {
			if (ok) {
				clearInterval(interval);
				cleared = true;
			}
		});

		return () => {
			clearInterval(interval);
			cleared = true;
		};
	}, []);

	isDraggingRef.current = isDragging;
	scaleRef.current = scale;

	// macOS-style magnification: icons grow near the pointer and push their
	// neighbours apart. Driven by direct style writes (no React re-renders).
	useEffect(() => {
		const root = dockRef.current;
		if (!dockMagnify || !root) return;

		type MagItem = {
			wrapper: HTMLElement;
			icon: HTMLElement;
			center: number;
			scale: number;
			shift: number;
		};
		let items: MagItem[] = [];
		let pointerX: number | null = null;
		let lastMove = 0;
		let raf = 0;

		const measure = () => {
			const previous = new Map(items.map((item) => [item.wrapper, item]));
			items = [];
			root.querySelectorAll<HTMLElement>(".dock-icon-wrapper").forEach((wrapper) => {
				const icon = wrapper.querySelector<HTMLElement>(".dock-icon");
				if (!icon) return;
				const prev = previous.get(wrapper);
				const shift = prev ? prev.shift : 0;
				const rect = wrapper.getBoundingClientRect();
				items.push({
					wrapper,
					icon,
					// Base (un-shifted) center, in viewport pixels.
					center: rect.left + rect.width / 2 - shift * scaleRef.current,
					scale: prev ? prev.scale : 1,
					shift
				});
			});
		};

		const reset = () => {
			root.style.removeProperty("--mag-x");
			root.style.removeProperty("--mag-y");
			items.forEach((item) => {
				item.icon.style.removeProperty("scale");
				item.wrapper.style.removeProperty("translate");
				item.wrapper.style.removeProperty("--mag");
				item.scale = 1;
				item.shift = 0;
			});
		};

		const step = () => {
			raf = 0;
			const now = performance.now();
			// Release if the pointer stopped reporting (e.g. window became click-through).
			if (pointerX !== null && (isDraggingRef.current || now - lastMove > 400)) pointerX = null;

			const k = scaleRef.current || 1;
			const radius = 95 * k;
			let settled = true;
			const extras: number[] = [];
			let total = 0;

			for (const item of items) {
				let target = 1;
				if (pointerX !== null) {
					const t = Math.min(Math.abs(pointerX - item.center) / radius, 1);
					target = 1 + (dockMagnifySize - 1) * Math.pow(Math.cos((t * Math.PI) / 2), 2);
				}
				item.scale += (target - item.scale) * 0.28;
				if (Math.abs(target - item.scale) < 0.003) item.scale = target;
				else settled = false;
				const extra = (item.scale - 1) * item.icon.offsetWidth;
				extras.push(extra);
				total += extra;
			}

			if (pointerX === null && settled) {
				reset();
				return;
			}

			// Grow the dock bar so enlarged icons stay inside it (like macOS).
			let maxScale = 1;
			let iconH = 36;
			for (const item of items) {
				if (item.scale > maxScale) maxScale = item.scale;
				iconH = item.icon.offsetHeight || iconH;
			}
			root.style.setProperty("--mag-x", `${total / 2}px`);
			root.style.setProperty("--mag-y", `${(maxScale - 1) * iconH}px`);

			let prefix = 0;
			items.forEach((item, i) => {
				item.shift = prefix - total / 2 + extras[i] / 2;
				prefix += extras[i];
				item.icon.style.setProperty("scale", String(item.scale));
				item.wrapper.style.setProperty("translate", `${item.shift}px 0`);
				item.wrapper.style.setProperty("--mag", String(item.scale));
			});
			raf = requestAnimationFrame(step);
		};

		const onMove = (e: MouseEvent) => {
			if (isDraggingRef.current) return;
			pointerX = e.clientX;
			lastMove = performance.now();
			if (!raf) {
				measure();
				raf = requestAnimationFrame(step);
			}
		};
		const onLeave = () => {
			pointerX = null;
		};

		root.addEventListener("mousemove", onMove);
		root.addEventListener("mouseleave", onLeave);
		return () => {
			root.removeEventListener("mousemove", onMove);
			root.removeEventListener("mouseleave", onLeave);
			if (raf) cancelAnimationFrame(raf);
			reset();
		};
	}, [dockMagnify, dockMagnifySize, isExpanded]);

	useEffect(() => {
		const updateRect = () => {
			if (dockRef.current) {
				const rect = dockRef.current.getBoundingClientRect();
				const hasPreview = !!previewData;
				// Magnified icons pop out above the dock: keep that area interactive.
				const magExtra = dockMagnify ? Math.round((dockMagnifySize - 1) * 44) : 0;
				invoke(RECT_COMMAND, {
					rect: {
						x: Math.round(rect.x) - (hasPreview ? 500 : 0),
						y: Math.round(rect.y) - magExtra - (hasPreview ? 320 : 0),
						width: Math.round(rect.width) + (hasPreview ? 1000 : 0),
						height: Math.round(rect.height) + magExtra + (hasPreview ? 320 : 0)
					}
				}).catch(() => {});
			}
		};

		updateRect();
		window.addEventListener("resize", updateRect);
		const observer = new ResizeObserver(updateRect);
		if (dockRef.current) observer.observe(dockRef.current);

		return () => {
			window.removeEventListener("resize", updateRect);
			observer.disconnect();
		};
	}, [pinnedApps, activeApps, isHidden, previewData, scale, dockMagnify, dockMagnifySize]);

	useEffect(() => {
		const init = async () => {
			const settings: any = await invoke("load_settings").catch(() => ({}));
			const getVal = (key: string, fallback: string | null = null) => {
				const val = settings[key];
				if (val !== undefined && val !== null) return String(val);
				const local = localStorage.getItem(key);
				if (local !== null) return local;
				return fallback;
			};

			const dMode = getVal("bloom-dock-mode", "fixed");
			if (dMode) {
				const mapped = dMode === "auto-hide" ? "smart" : dMode;
				setDockMode(mapped);
			}

			const preview = getVal("bloom-dock-preview-enabled", "true");
			setDockPreviewEnabled(preview === "true");

			const iconOnly = getVal("bloom-dock-icon-only", "false");
			setDockIconOnly(iconOnly === "true");

			const adaptive = getVal("bloom-dock-adaptive", "false");
			setDockAdaptive(adaptive === "true");

			const trayEnabled = getVal("bloom-dock-tray-enabled", "true");
			setDockTrayEnabled(trayEnabled !== "false");

			setDockMagnify(getVal("bloom-dock-magnify", "true") !== "false");
			const magSize = parseFloat(getVal("bloom-dock-magnify-size", "1.3") || "1.3");
			if (!isNaN(magSize)) setDockMagnifySize(Math.min(Math.max(magSize, 1.1), 1.6));
			setDockBounce(getVal("bloom-dock-bounce", "true") !== "false");
			setDockOpenClose(getVal("bloom-dock-openclose-anim", "false") === "true");

			const startIconVal = getVal("bloom-start-icon", "default") || "default";
			setStartIcon(startIconVal);

			const scaleVal = getVal("bloom-scale");
			if (scaleVal !== null) setScale(parseFloat(scaleVal));

			const pinned = await invoke<AppInfo[]>("load_pinned_apps");
			setPinnedApps(pinned.map((a) => ({ ...a, is_pinned: true })));
			pinned.forEach((app) => fetchIcon(app.path));

			// Load custom icons
			try {
				const icons = await invoke<Record<string, string>>("get_custom_icons");
				setCustomIcons(icons);
			} catch (_) {}
		};
		init();

		const unlistenOverlap = listen<boolean>("dock-overlap", (event) => {
			if (!IS_SECONDARY_DOCK) setIsOverlapped(event.payload);
		});

		// Extra-monitor docks get their own edge-hover / overlap state from Rust.
		const unlistenSecondary = listen<{ edge: boolean; overlapped: boolean }>(
			"secondary-dock-state",
			(event) => {
				if (!IS_SECONDARY_DOCK) return;
				setIsEdgeHovered(event.payload.edge);
				setIsOverlapped(event.payload.overlapped);
			}
		);

		const unlistenEdgeHover = listen<boolean>("dock-edge-hover", (event) => {
			if (!IS_SECONDARY_DOCK) setIsEdgeHovered(event.payload);
		});

		const unlistenVisibility = listen<boolean>("visibility-change", (event) => {
			setIsVisible(event.payload);
		});

		const unlistenMaximized = listen<boolean>("dock-maximized", (event) => {
			setIsMaximized(event.payload);
		});

		return () => {
			unlistenOverlap.then((f) => f());
			unlistenEdgeHover.then((f) => f());
			unlistenSecondary.then((f) => f());
			unlistenVisibility.then((f) => f());
			unlistenMaximized.then((f) => f());
		};
	}, []);

	useSettingsSync({
		"bloom-dock-mode": setDockMode,
		"bloom-dock-preview-enabled": setDockPreviewEnabled,
		"bloom-dock-icon-only": setDockIconOnly,
		"bloom-dock-adaptive": setDockAdaptive,
		"bloom-dock-tray-enabled": setDockTrayEnabled,
		"bloom-dock-magnify": setDockMagnify,
		"bloom-dock-magnify-size": setDockMagnifySize,
		"bloom-dock-bounce": setDockBounce,
		"bloom-dock-openclose-anim": setDockOpenClose,
		"bloom-start-icon": setStartIcon,
		"bloom-scale": setScale
	});

	useEffect(() => {
		let pollSeq = 0;

		const poll = async () => {
			if (isDragging) return;
			const seq = ++pollSeq;
			const running = await invoke<AppInfo[]>("get_active_windows");
			// Ignore responses that arrive out of order: an older poll must never
			// overwrite a newer state, which would resurrect closed apps.
			if (seq !== pollSeq) return;
			setActiveApps(running);

			setActiveOrder((prev) => {
				const newPaths = running.map((r) => appIdentity(r.path, r.executable, r.name));
				const existingPaths = prev.filter((p) => newPaths.includes(p));
				const addedPaths = newPaths.filter((p) => !prev.includes(p));
				return [...existingPaths, ...addedPaths];
			});

			running.forEach((app) => fetchIcon(app.path, app.name, app.hwnd));
		};

		poll();

		const unlistenWindowChange = listen("windows-changed", () => {
			poll();
		});

		// Safety net: even if a window event is missed, converge on the real state
		const interval = setInterval(poll, 10000);

		return () => {
			clearInterval(interval);
			unlistenWindowChange.then((f) => f());
		};
	}, [isDragging]);

	const fetchIcon = async (path: string, name?: string, hwnd?: number, retryCount = 0) => {
		const isHost = isBrowserHost(path);
		const cacheKey =
			isHost && name ? `${path}:${name.toLowerCase()}` : hwnd ? `${path}-${hwnd}` : path;

		if (iconsRef.current[cacheKey]) return;
		try {
			const icon = await invoke<string | null>("get_app_icon", {
				path,
				name: name || null,
				hwnd: hwnd || null
			});
			if (icon) {
				iconsRef.current[cacheKey] = icon;
				if (!isHost) iconsRef.current[path] = icon;
				setIconsTick((t) => t + 1);
			} else if (retryCount < 3 && !hwnd) {
				setTimeout(() => fetchIcon(path, name, undefined, retryCount + 1), 3000 * (retryCount + 1));
			}
		} catch (e) {
			console.error(`Failed to fetch icon for ${path}:`, e);
			if (retryCount < 3 && !hwnd) {
				setTimeout(() => fetchIcon(path, name, undefined, retryCount + 1), 3000 * (retryCount + 1));
			}
		}
	};

	const handleClearIconCache = async () => {
		try {
			await invoke("clear_icon_cache");
			iconsRef.current = {};
			setIconsTick((t) => t + 1);
			pinnedApps.forEach((app) => fetchIcon(app.path));
		} catch (e) {
			console.error("Failed to clear icon cache:", e);
		}
	};

	const handleIconFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		const target = iconPickerTargetRef.current;
		if (!file || !target) return;

		const reader = new FileReader();
		reader.onload = async () => {
			const dataUri = reader.result as string;
			try {
				const newIcon = await invoke<string>("set_custom_icon", {
					cacheKey: target,
					iconData: dataUri
				});
				setCustomIcons((prev) => ({ ...prev, [target]: newIcon }));
			} catch (err) {
				const msg = typeof err === "string" ? err : translate("Failed to set icon");
				if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
				setToast(msg);
				toastTimerRef.current = setTimeout(() => setToast(null), 4000);
			}
		};
		reader.readAsDataURL(file);
		e.target.value = "";
	};

	const handleRemoveCustomIcon = async (app: AppInfo) => {
		try {
			await invoke("remove_custom_icon", {
				path: app.path,
				name: app.name || null
			});
			const isHost = isBrowserHost(app.path);
			const ck =
				isHost && app.name
					? `${app.path}:${app.name.toLowerCase()}`
					: app.hwnd
						? `${app.path}-${app.hwnd}`
						: app.path;
			setCustomIcons((prev) => {
				const next = { ...prev };
				delete next[ck];
				delete next[app.path];
				return next;
			});
			// Invalidate only this app's cached icon and re-fetch only this app
			delete iconsRef.current[ck];
			delete iconsRef.current[app.path];
			if (app.hwnd) delete iconsRef.current[`${app.path}-${app.hwnd}`];
			setIconsTick((t) => t + 1);
			fetchIcon(app.path, app.name, app.hwnd);
		} catch (err) {
			console.error("Failed to remove custom icon:", err);
		}
	};

	const handleClosePreview = async (e: React.MouseEvent, hwnd: number) => {
		e.stopPropagation();
		try {
			await invoke("close_window", { hwnd });
			setPreviewData((prev) => {
				if (!prev) return null;
				const remaining = prev.previews.filter((p) => p.hwnd !== hwnd);
				if (remaining.length === 0) {
					setHoveredApp(null);
					return null;
				}
				return { ...prev, previews: remaining };
			});
		} catch (err) {
			console.error("Failed to close window:", err);
		}
	};

	const handleAppClick = async (app: AppInfo) => {
		try {
			if (app.path === "start") {
				await invoke("open_app", { appName: "start" });
			} else if (app.hwnd) {
				await invoke("focus_window", { hwnd: app.hwnd });
			} else {
				if (dockBounce) {
					// macOS-style bounce while the app is starting.
					setBouncingApp(itemKey(app));
					setTimeout(() => setBouncingApp(null), 1300);
				}
				await invoke("open_app", { appName: app.path });
			}
		} catch (e) {
			console.error(`Failed to interact with ${app.name}:`, e);
		}
	};

	const handleNewInstance = async (app: AppInfo) => {
		if (!app || app.path === "start") return;
		try {
			await invoke("launch_new_instance", {
				appPath: app.path,
				appName: app.name
			});
		} catch (e) {
			console.error(`Failed to launch a new instance of ${app.name}:`, e);
		}
	};

	// Middle-click opens a new instance, matching the native taskbar. The
	// mousedown preventDefault suppresses Chromium's autoscroll cursor.
	const handleMiddleClick = (e: React.MouseEvent, app: AppInfo) => {
		if (e.button !== 1) return;
		e.preventDefault();
		e.stopPropagation();
		handleNewInstance(app);
	};

	const togglePin = async (app: AppInfo) => {
		let newPinned;
		if (app.is_pinned) {
			newPinned = pinnedApps.filter((a) => a.path !== app.path);
		} else {
			if (pinnedApps.find((a) => a.path === app.path)) return;
			newPinned = [...pinnedApps, { ...app, is_pinned: true, is_running: false, hwnd: undefined }];
			fetchIcon(app.path, app.name);
		}
		setPinnedApps(newPinned);
		await invoke("save_pinned_apps", { apps: newPinned });
		closeMenu();
	};

	const menuRef = useRef<HTMLDivElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);

	const handleContextMenu = (e: React.MouseEvent, app: AppInfo | null) => {
		e.stopPropagation();
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, app });
	};

	const closeMenu = () => {
		setContextMenu(null);
		setActiveSubmenu(null);
		invoke(MENU_COMMAND, { open: false, rect: null }).catch(() => {});
	};

	const closePopup = () => {
		setShowAddPopup(false);
		invoke(MENU_COMMAND, { open: false, rect: null }).catch(() => {});
	};

	useEffect(() => {
		let open = false;
		let rect = null;

		if (contextMenu && menuRef.current) {
			const r = menuRef.current.getBoundingClientRect();
			rect = {
				x: Math.round(r.x),
				y: Math.round(r.y),
				width: Math.round(r.width + (activeSubmenu ? 160 : 0)),
				height: Math.round(r.height)
			};
			open = true;
		} else if (showAddPopup && popupRef.current) {
			const r = popupRef.current.getBoundingClientRect();
			rect = {
				x: Math.round(r.x),
				y: Math.round(r.y),
				width: Math.round(r.width),
				height: Math.round(r.height)
			};
			open = true;
		}

		invoke(MENU_COMMAND, { open, rect }).catch(() => {});
	}, [contextMenu, showAddPopup, pinnedApps, activeApps, activeSubmenu, scale]);

	const dockItems = useMemo(() => {
		const runningMap = new Map();
		activeApps.forEach((a) => {
			const id = appIdentity(a.path, a.executable, a.name);
			if (!runningMap.has(id)) runningMap.set(id, a);
		});

		const matchedRunningKeys = new Set<string>();

		const findRunningApp = (p: AppInfo) => {
			// 1. Try exact match by identity
			const id = appIdentity(p.path, p.executable, p.name);
			let running = runningMap.get(id);
			if (running) {
				matchedRunningKeys.add(appIdentity(running.path, running.executable, running.name));
				return running;
			}

			// 2. Try match by path (without executable)
			const pathId = appIdentity(p.path);
			running = runningMap.get(pathId);
			if (running) {
				matchedRunningKeys.add(appIdentity(running.path, running.executable, running.name));
				return running;
			}

			// 3. Try fallback match by executable name if defined
			if (p.executable) {
				const targetExe = p.executable.toLowerCase();
				const found = activeApps.find(
					(a) => !isIdentifier(a.path) && a.executable?.toLowerCase() === targetExe
				);
				if (found) {
					matchedRunningKeys.add(appIdentity(found.path, found.executable, found.name));
					return found;
				}
			}

			// 4. Try fallback match by path's file name (e.g., if path is "msedge" and running app's executable is "msedge.exe")
			const pinFilename = p.path.split("/").pop()?.split("\\").pop()?.toLowerCase() || "";
			if (pinFilename) {
				const found = activeApps.find((a) => {
					if (isIdentifier(a.path)) return false;
					const runExe =
						a.executable?.toLowerCase() ||
						a.path.split("/").pop()?.split("\\").pop()?.toLowerCase() ||
						"";
					return (
						runExe === pinFilename ||
						runExe === `${pinFilename}.exe` ||
						`${runExe}.exe` === pinFilename
					);
				});
				if (found) {
					matchedRunningKeys.add(appIdentity(found.path, found.executable, found.name));
					return found;
				}
			}

			return undefined;
		};

		const pinned: AppInfo[] = [
			{
				name: "Start",
				path: "start",
				icon: null,
				is_running: false,
				is_pinned: true,
				hwnd: undefined,
				all_hwnds: undefined,
				executable: undefined
			},
			...pinnedApps.map((p) => {
				const running = findRunningApp(p);
				return {
					...p,
					is_running: !!running,
					hwnd: running?.hwnd,
					all_hwnds: running?.all_hwnds
				};
			})
		];

		const unpinned = activeOrder
			.map((id) => activeApps.find((a) => appIdentity(a.path, a.executable, a.name) === id))
			.filter(
				(a): a is AppInfo =>
					!!a && !matchedRunningKeys.has(appIdentity(a.path, a.executable, a.name))
			);

		return [...pinned, ...unpinned];
	}, [pinnedApps, activeApps, activeOrder]);

	const startItem = useMemo(
		() => dockItems.find((i) => i.path === "start") as AppInfo,
		[dockItems]
	);
	const pinnedItems = useMemo(
		() => dockItems.filter((i) => i.path !== "start" && i.is_pinned),
		[dockItems]
	);
	const unpinnedItems = useMemo(() => dockItems.filter((i) => !i.is_pinned), [dockItems]);

	// Latest state for the Win+Number listener, which subscribes only once.
	useEffect(() => {
		pinnedItemsRef.current = pinnedItems;
		handleAppClickRef.current = handleAppClick;
	});

	useEffect(() => {
		// The backend claims Win+1-9 while the native taskbar is hidden and reports
		// which pinned slot was pressed; behaviour matches a click on that icon.
		const unlisten = listen<number>("dock-win-number", (event) => {
			const app = pinnedItemsRef.current[event.payload];
			if (app) handleAppClickRef.current(app);
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	const handleReorder = (newPaths: string[]) => {
		const oldPaths = pinnedApps.map((p) => p.path);
		if (JSON.stringify(newPaths) !== JSON.stringify(oldPaths)) {
			const reordered = newPaths
				.map((path) => pinnedApps.find((p) => p.path === path))
				.filter((p): p is AppInfo => !!p);
			setPinnedApps(reordered);
		}
	};

	const handleDragEnd = () => {
		setIsDragging(false);
		setPressedApp(null);
		invoke("save_pinned_apps", { apps: pinnedApps }).catch(console.error);
	};

	useEffect(() => {
		// Only report true dock-window hover, not the edge-hover from Rust,
		// to avoid a feedback loop that keeps the dock open.
		if (IS_SECONDARY_DOCK) return;
		invoke("set_dock_hovered", { hovered: isDockHovered }).catch(() => {});
	}, [isDockHovered]);

	useEffect(() => {
		const handleBlur = () => {
			closeMenu();
			closePopup();
		};
		window.addEventListener("blur", handleBlur);
		return () => window.removeEventListener("blur", handleBlur);
	}, []);

	useEffect(() => {
		if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
		isPreviewHoveredRef.current = false;
		hoveredAppRef.current = hoveredApp;

		if (!hoveredApp) {
			const timer = setTimeout(() => setPreviewData(null), 100);
			return () => clearTimeout(timer);
		}

		if (hoveredApp && !isDragging) {
			const app = dockItems.find((a) => itemKey(a) === hoveredApp);
			if (app && app.is_running) {
				const hwndsToCapture = app.all_hwnds || (app.hwnd ? [[app.hwnd, app.name]] : []);

				previewTimerRef.current = setTimeout(async () => {
					try {
						const results = await Promise.all(
							hwndsToCapture.map(async ([hwnd, title]) => {
								try {
									const res = await invoke<[string, number] | null>("capture_window_thumbnail", {
										hwnd,
										maxWidth: 320,
										maxHeight: 200
									});
									if (res) {
										const [image, lastFocused] = res;
										return { hwnd, title, image, lastFocused };
									}
								} catch {}
								return null;
							})
						);

						const captured = results
							.filter(
								(
									r
								): r is {
									hwnd: number;
									title: string;
									image: string;
									lastFocused: number;
								} => r !== null
							)
							.sort((a, b) => b.lastFocused - a.lastFocused)
							.map(({ hwnd, title, image }) => ({ hwnd, title, image }));

						const currentHovered = hoveredAppRef.current;
						if (captured.length > 0 && currentHovered === itemKey(app)) {
							setPreviewData({ id: itemKey(app), previews: captured });
						} else if (currentHovered === itemKey(app)) {
							setPreviewData(null);
						}
					} catch (e) {
						console.error("Failed to capture thumbnails:", e);
						setPreviewData(null);
					}
				}, 300);
			} else {
				setPreviewData(null);
			}
		}

		return () => {
			if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
		};
	}, [hoveredApp, isDragging, dockItems]);

	const iconVariants = {
		idle: { y: 0, scale: 1 },
		hover: dockMagnify ? { y: 0, scale: 1 } : { y: -5, scale: 1.1 },
		drag: { y: -10, scale: 1.1, opacity: 0.8 },
		tap: { scale: 0.95 }
	};

	return (
		<div
			className={`dock-container ${isDragging ? "dragging" : ""} ${dockMagnify ? "dock-magnify" : ""}`}
			onClick={closeMenu}
		>
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					justifyContent: "center",
					alignItems: "flex-end"
				}}
			>
				<motion.div
					ref={dockRef}
					layout
					className={`dock ${isExpanded && !isHidden ? "dock-expanded" : ""} ${isImpacted && !isExpanded && !isHidden ? "dock-impacted" : ""} ${dockIconOnly ? "dock-icon-only" : ""} ${isAdaptive ? "dock-adaptive" : ""}`}
					onMouseEnter={() => setIsDockHovered(true)}
					onMouseLeave={() => {
						setIsDockHovered(false);
						setHoveredApp(null);
						setPressedApp(null);
					}}
					initial={{
						y: -800,
						opacity: 1,
						width: 34,
						height: 34,
						borderTopLeftRadius: 17,
						borderTopRightRadius: 17,
						borderBottomLeftRadius: 17,
						borderBottomRightRadius: 17
					}}
					animate={{
						y: !isReady ? -800 : isVisible ? (isHidden ? 100 : 0) : 150,
						width:
							isExpanded && !isHidden && isVisible ? (isAdaptive ? adaptiveWidth : "auto") : 34,
						height: isExpanded && !isHidden && isVisible ? "auto" : 34,
						borderTopLeftRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 18 : 17,
						borderTopRightRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 18 : 17,
						borderBottomLeftRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 0 : 17,
						borderBottomRightRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 0 : 17,
						opacity: isVisible ? 1 : 0,
						scale: scale
					}}
					transition={{
						y: { type: "spring", stiffness: 400, damping: 35, mass: 0.8 },
						width: { type: "spring", stiffness: 250, damping: 22, mass: 0.8 },
						height: { type: "spring", stiffness: 250, damping: 22, mass: 0.8 },
						layout: isDragging ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 25 },
						borderTopLeftRadius: {
							type: "spring",
							stiffness: 500,
							damping: 30
						},
						borderTopRightRadius: {
							type: "spring",
							stiffness: 500,
							damping: 30
						},
						borderBottomLeftRadius: {
							type: "spring",
							stiffness: 500,
							damping: 30
						},
						borderBottomRightRadius: {
							type: "spring",
							stiffness: 500,
							damping: 30
						},
						opacity: { type: "tween", duration: 0.2 },
						scale: { duration: 0 }
					}}
					style={{ originX: 0.5, originY: 1, minWidth: 34 }}
					onContextMenu={(e) => handleContextMenu(e, null)}
				>
					{/* Backdrop that grows with the magnified icons (see .dock-mag-bg) */}
					<div className="dock-mag-bg" aria-hidden="true" />
					<AnimatePresence>
						{isExpanded && (
							<motion.div
								key="dock-content"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.15 }}
								className="dock-reorder-container"
							>
								{startItem && (
									<motion.div
										initial={{ opacity: 0, scale: 0 }}
										animate={{ opacity: 1, scale: 1 }}
										transition={{
											opacity: { duration: 0.15, delay: 0.15 },
											scale: {
												type: "spring",
												stiffness: 400,
												damping: 25,
												delay: 0.15
											}
										}}
										className="dock-icon-wrapper"
										onContextMenu={(e) => handleContextMenu(e, startItem)}
										onMouseEnter={() => setHoveredApp(itemKey(startItem))}
										onMouseLeave={() => {
											setHoveredApp(null);
											setPressedApp(null);
										}}
									>
										{(!dockPreviewEnabled ||
											(dockPreviewEnabled && hoveredApp === itemKey(startItem))) && (
											<div className="tooltip">{startItem.name}</div>
										)}
										<motion.div
											className="dock-icon"
											variants={iconVariants}
											animate={
												pressedApp === itemKey(startItem)
													? "tap"
													: hoveredApp === itemKey(startItem)
														? "hover"
														: "idle"
											}
											onPointerDown={() => setPressedApp(itemKey(startItem))}
											onPointerUp={() => setPressedApp(null)}
											onPointerCancel={() => setPressedApp(null)}
											onClick={(e) => {
												e.stopPropagation();
												handleAppClick(startItem);
											}}
										>
											<img
												src={resolveStartIcon(startIcon)}
												alt="Start"
												className="bloom-icon-img"
												style={
													startIcon.startsWith("custom:") ? { borderRadius: "8px" } : undefined
												}
												draggable={false}
											/>
										</motion.div>
									</motion.div>
								)}

								<Reorder.Group
									as="div"
									axis="x"
									values={pinnedItems.map((i) => i.path)}
									onReorder={handleReorder}
									className="dock-reorder-group"
								>
									{pinnedItems.map((app) => (
										<Reorder.Item
											as="div"
											key={app.path}
											value={app.path}
											style={{ position: "relative" }}
											onDragStart={() => {
												setIsDragging(true);
												setHoveredApp(null);
												setPressedApp(null);
											}}
											onDragEnd={handleDragEnd}
											onContextMenu={(e) => handleContextMenu(e, app)}
											onMouseDown={(e) => {
												if (e.button === 1) e.preventDefault();
											}}
											onAuxClick={(e) => handleMiddleClick(e, app)}
											onClick={(e) => {
												e.stopPropagation();
												if (!isDragging) handleAppClick(app);
											}}
										>
											<motion.div
												className="dock-icon-wrapper"
												initial={ITEM_INITIAL}
												animate={ITEM_ANIMATE}
												exit={ITEM_EXIT}
												transition={ITEM_ENTRY_TRANSITION}
												onMouseEnter={() => setHoveredApp(itemKey(app))}
												onMouseLeave={() => {
													if (!isPreviewHoveredRef.current) {
														setHoveredApp(null);
														setPressedApp(null);
													}
												}}
											>
												<AnimatePresence>
													{dockPreviewEnabled &&
														previewData &&
														previewData.id === itemKey(app) &&
														hoveredApp === itemKey(app) && (
															<motion.div
																className={`preview-tooltip ${previewData.previews.length > 1 ? "multi" : ""}`}
																initial={{ opacity: 0, y: 10, scale: 0.95 }}
																animate={{ opacity: 1, y: 0, scale: 1 }}
																exit={{ opacity: 0, scale: 0.95 }}
																transition={{ duration: 0.15 }}
																onMouseEnter={() => {
																	isPreviewHoveredRef.current = true;
																}}
																onMouseLeave={() => {
																	isPreviewHoveredRef.current = false;
																	setHoveredApp(null);
																	setPressedApp(null);
																}}
															>
																<div className="preview-items">
																	{previewData.previews.map((prev, idx) => (
																		<div
																			key={prev.hwnd}
																			className="preview-item"
																			onClick={() =>
																				invoke("focus_window", {
																					hwnd: prev.hwnd
																				})
																			}
																		>
																			<img src={prev.image} alt={`Preview ${idx}`} />
																			<div className="preview-label">{prev.title || app.name}</div>
																			<button
																				className="preview-close-btn"
																				onClick={(e) => handleClosePreview(e, prev.hwnd)}
																				title={t("Close Window")}
																			>
																				<svg
																					width="10"
																					height="10"
																					viewBox="0 0 24 24"
																					fill="none"
																					stroke="currentColor"
																					strokeWidth="3"
																					strokeLinecap="round"
																				>
																					<line x1="18" y1="6" x2="6" y2="18"></line>
																					<line x1="6" y1="6" x2="18" y2="18"></line>
																				</svg>
																			</button>
																		</div>
																	))}
																</div>
															</motion.div>
														)}
												</AnimatePresence>

												{/* Fallback to text tooltip if previews are disabled, app isn't running, or preview failed to load */}
												{(!dockPreviewEnabled ||
													(dockPreviewEnabled && hoveredApp === itemKey(app) && !previewData)) && (
													<div className="tooltip">{app.name}</div>
												)}
												<motion.div
													className={`dock-icon${bouncingApp === itemKey(app) ? " dock-bounce" : ""}`}
													variants={iconVariants}
													animate={
														pressedApp === itemKey(app)
															? "tap"
															: isDragging && !app.is_pinned
																? "idle"
																: hoveredApp === itemKey(app) && !isDragging
																	? "hover"
																	: "idle"
													}
													whileDrag="drag"
													onPointerDown={() => setPressedApp(itemKey(app))}
													onPointerUp={() => setPressedApp(null)}
													onPointerCancel={() => setPressedApp(null)}
												>
													{(() => {
														const isHost = isBrowserHost(app.path);
														const cacheKey = isHost
															? `${app.path}:${app.name.toLowerCase()}`
															: app.hwnd
																? `${app.path}-${app.hwnd}`
																: app.path;
														// Running host items must not use the shared path fallback: the
														// browser and its PWAs share one path, so it would leak one item's
														// icon onto the others.
														const allowPathFallback = !isHost || !app.is_running;
														const icon =
															customIcons[cacheKey] ||
															(allowPathFallback && customIcons[app.path]) ||
															iconsRef.current[cacheKey] ||
															(allowPathFallback && iconsRef.current[app.path]) ||
															app.icon;

														const isBloomOrSettings =
															app.name.toLowerCase() === "settings" ||
															app.name.toLowerCase() === "bloom" ||
															app.path.toLowerCase().includes("bloom.exe");

														return icon ? (
															<img
																src={icon}
																alt={app.name}
																className={isBloomOrSettings ? "bloom-icon-img" : ""}
																draggable={false}
															/>
														) : (
															<div className="fallback-icon">{app.name[0]}</div>
														);
													})()}
												</motion.div>
												{app.is_running && <div className="active-indicator" />}
											</motion.div>
										</Reorder.Item>
									))}
								</Reorder.Group>

								<AnimatePresence initial={false}>
									{unpinnedItems.map((app) => (
										<motion.div
											key={app.path}
											layout
											style={dockOpenClose ? { transformOrigin: "50% 100%" } : undefined}
											initial={
												dockOpenClose
													? {
															opacity: 0,
															scale: 0.2,
															width: 0,
															marginLeft: -6,
															marginRight: -6
														}
													: { opacity: 0, scale: 0 }
											}
											animate={
												dockOpenClose
													? {
															opacity: 1,
															scale: 1,
															width: "auto",
															marginLeft: 0,
															marginRight: 0,
															transition: {
																width: {
																	type: "spring",
																	stiffness: 260,
																	damping: 26
																},
																marginLeft: {
																	type: "spring",
																	stiffness: 260,
																	damping: 26
																},
																marginRight: {
																	type: "spring",
																	stiffness: 260,
																	damping: 26
																},
																scale: {
																	type: "spring",
																	stiffness: 300,
																	damping: 17,
																	delay: 0.12
																},
																opacity: { duration: 0.2 }
															}
														}
													: {
															opacity: 1,
															scale: 1,
															transition: {
																opacity: { duration: 0.15, delay: 0.15 },
																scale: {
																	type: "spring",
																	stiffness: 400,
																	damping: 25,
																	delay: 0.15
																}
															}
														}
											}
											exit={
												dockOpenClose
													? {
															opacity: 0,
															scale: 0.2,
															width: 0,
															marginLeft: -6,
															marginRight: -6,
															y: -14,
															transition: {
																opacity: { duration: 0.22 },
																scale: {
																	duration: 0.28,
																	ease: [0.4, 0, 0.2, 1]
																},
																y: { duration: 0.28, ease: [0.4, 0, 0.2, 1] },
																width: {
																	duration: 0.3,
																	delay: 0.1,
																	ease: [0.4, 0, 0.2, 1]
																},
																marginLeft: {
																	duration: 0.3,
																	delay: 0.1,
																	ease: [0.4, 0, 0.2, 1]
																},
																marginRight: {
																	duration: 0.3,
																	delay: 0.1,
																	ease: [0.4, 0, 0.2, 1]
																}
															}
														}
													: {
															opacity: 0,
															scale: 0,
															transition: { duration: 0.12 }
														}
											}
											className="dock-icon-wrapper"
											onContextMenu={(e) => handleContextMenu(e, app)}
											onMouseEnter={() => setHoveredApp(itemKey(app))}
											onMouseLeave={() => {
												if (!isPreviewHoveredRef.current) {
													setHoveredApp(null);
													setPressedApp(null);
												}
											}}
											onMouseDown={(e) => {
												if (e.button === 1) e.preventDefault();
											}}
											onAuxClick={(e) => handleMiddleClick(e, app)}
											onClick={(e) => {
												e.stopPropagation();
												handleAppClick(app);
											}}
										>
											<AnimatePresence>
												{dockPreviewEnabled &&
													previewData &&
													previewData.id === itemKey(app) &&
													hoveredApp === itemKey(app) && (
														<motion.div
															className={`preview-tooltip ${previewData.previews.length > 1 ? "multi" : ""}`}
															initial={{ opacity: 0, y: 10, scale: 0.95 }}
															animate={{ opacity: 1, y: 0, scale: 1 }}
															exit={{ opacity: 0, scale: 0.95 }}
															transition={{ duration: 0.15 }}
															onMouseEnter={() => {
																isPreviewHoveredRef.current = true;
															}}
															onMouseLeave={() => {
																isPreviewHoveredRef.current = false;
																setHoveredApp(null);
																setPressedApp(null);
															}}
														>
															<div className="preview-items">
																{previewData.previews.map((prev, idx) => (
																	<div
																		key={prev.hwnd}
																		className="preview-item"
																		onClick={() =>
																			invoke("focus_window", {
																				hwnd: prev.hwnd
																			})
																		}
																	>
																		<img src={prev.image} alt={`Preview ${idx}`} />
																		<div className="preview-label">{prev.title || app.name}</div>
																		<button
																			className="preview-close-btn"
																			onClick={(e) => handleClosePreview(e, prev.hwnd)}
																			title={t("Close Window")}
																		>
																			<svg
																				width="10"
																				height="10"
																				viewBox="0 0 24 24"
																				fill="none"
																				stroke="currentColor"
																				strokeWidth="3"
																				strokeLinecap="round"
																			>
																				<line x1="18" y1="6" x2="6" y2="18"></line>
																				<line x1="6" y1="6" x2="18" y2="18"></line>
																			</svg>
																		</button>
																	</div>
																))}
															</div>
														</motion.div>
													)}
											</AnimatePresence>
											{(!dockPreviewEnabled ||
												(dockPreviewEnabled && hoveredApp === itemKey(app) && !previewData)) && (
												<div className="tooltip">{app.name}</div>
											)}
											<motion.div
												className={`dock-icon${bouncingApp === itemKey(app) ? " dock-bounce" : ""}`}
												variants={iconVariants}
												animate={
													pressedApp === itemKey(app)
														? "tap"
														: hoveredApp === itemKey(app) && !isDragging
															? "hover"
															: "idle"
												}
												onPointerDown={() => setPressedApp(itemKey(app))}
												onPointerUp={() => setPressedApp(null)}
												onPointerCancel={() => setPressedApp(null)}
											>
												{(() => {
													const isHost = isBrowserHost(app.path);
													const cacheKey = isHost
														? `${app.path}:${app.name.toLowerCase()}`
														: app.hwnd
															? `${app.path}-${app.hwnd}`
															: app.path;
													// Running host items must not use the shared path fallback: the
													// browser and its PWAs share one path, so it would leak one item's
													// icon onto the others.
													const allowPathFallback = !isHost || !app.is_running;
													const icon =
														customIcons[cacheKey] ||
														(allowPathFallback && customIcons[app.path]) ||
														iconsRef.current[cacheKey] ||
														(allowPathFallback && iconsRef.current[app.path]) ||
														app.icon;
													const isBloomOrSettings =
														app.name.toLowerCase() === "settings" ||
														app.name.toLowerCase() === "bloom" ||
														app.path.toLowerCase().includes("bloom.exe");
													return icon ? (
														<img
															src={icon}
															alt={app.name}
															className={isBloomOrSettings ? "bloom-icon-img" : ""}
															draggable={false}
														/>
													) : (
														<div className="fallback-icon">{app.name[0]}</div>
													);
												})()}
											</motion.div>
											{app.is_running && <div className="active-indicator" />}
										</motion.div>
									))}
								</AnimatePresence>
								{dockTrayEnabled && <DockTrayButtons />}
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
			</div>

			{contextMenu && (
				<div
					ref={menuRef}
					className="context-menu"
					style={{
						left: contextMenu.x,
						top: contextMenu.y - (contextMenu.app ? 200 : 100) * scale,
						zoom: scale
					}}
					onClick={(e) => e.stopPropagation()}
				>
					{contextMenu.app ? (
						<>
							{contextMenu.app.is_running && contextMenu.app.path !== "start" && (
								<>
									<div
										className="menu-item"
										onClick={() => {
											handleNewInstance(contextMenu.app!);
											closeMenu();
										}}
									>
										{t("Open New Instance")}
									</div>
									<div className="menu-divider" />
								</>
							)}
							<div className="menu-item" onClick={() => togglePin(contextMenu.app!)}>
								{contextMenu.app.is_pinned ? t("Unpin from Dock") : t("Pin to Dock")}
							</div>
							{contextMenu.app.is_pinned && contextMenu.app.path !== "start" && (
								<>
									<div className="menu-divider" />
									<div
										className="menu-item"
										onClick={() => {
											const isHost = isBrowserHost(contextMenu.app!.path);
											const ck = isHost
												? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}`
												: contextMenu.app!.path;
											iconPickerTargetRef.current = ck;
											closeMenu();
											setTimeout(() => {
												document.getElementById("icon-file-input")?.click();
											}, 50);
										}}
									>
										{t("Change Icon...")}
									</div>
									{(() => {
										const isHost = isBrowserHost(contextMenu.app!.path);
										const ck = isHost
											? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}`
											: contextMenu.app!.path;
										return customIcons[ck] ? (
											<div
												className="menu-item"
												onClick={() => {
													handleRemoveCustomIcon(contextMenu.app!);
													closeMenu();
												}}
											>
												{t("Reset Icon")}
											</div>
										) : null;
									})()}
								</>
							)}
							<div className="menu-divider" />
							<div
								className="menu-item"
								onClick={() => {
									setShowAddPopup(true);
									closeMenu();
								}}
							>
								{t("Add App to Dock...")}
							</div>
							<div
								className="menu-item"
								onClick={() => {
									invoke("open_task_manager").catch((err) =>
										console.error("Failed to open Task Manager:", err)
									);
									closeMenu();
								}}
							>
								{t("Task Manager")}
							</div>
							<div
								className="menu-item has-submenu"
								onMouseEnter={() => setActiveSubmenu("bloom")}
								onMouseLeave={() => setActiveSubmenu(null)}
							>
								{t("Bloom Options")}
								<span className="submenu-arrow">▶</span>
								<div className="submenu">
									<div
										className="menu-item"
										onClick={() => {
											invoke("open_settings_window");
											closeMenu();
										}}
									>
										{t("Open Settings")}
									</div>
									<div className="menu-item" onClick={() => invoke("restart_bloom")}>
										{t("Restart Bloom")}
									</div>
									<div
										className="menu-item"
										onClick={() => {
											handleClearIconCache();
											closeMenu();
										}}
									>
										{t("Clear Icon Cache")}
									</div>
									<div className="menu-divider" />
									<div className="menu-item quit" onClick={() => invoke("quit_bloom")}>
										{t("Quit Bloom")}
									</div>
								</div>
							</div>
							{contextMenu.app.is_running && (
								<>
									<div className="menu-divider" />
									<div
										className="menu-item quit"
										onClick={async () => {
											if (contextMenu.app?.hwnd) {
												await invoke("close_window", {
													hwnd: contextMenu.app.hwnd
												});
												closeMenu();
											}
										}}
									>
										Quit {contextMenu.app.name}
									</div>
								</>
							)}
						</>
					) : (
						<>
							<div
								className="menu-item"
								onClick={() => {
									setShowAddPopup(true);
									closeMenu();
								}}
							>
								{t("Add App to Dock...")}
							</div>
							<div
								className="menu-item"
								onClick={() => {
									invoke("open_task_manager").catch((err) =>
										console.error("Failed to open Task Manager:", err)
									);
									closeMenu();
								}}
							>
								{t("Task Manager")}
							</div>
							<div
								className="menu-item has-submenu"
								onMouseEnter={() => setActiveSubmenu("bloom")}
								onMouseLeave={() => setActiveSubmenu(null)}
							>
								{t("Bloom Options")}
								<span className="submenu-arrow">▶</span>
								<div className="submenu">
									<div
										className="menu-item"
										onClick={() => {
											invoke("open_settings_window");
											closeMenu();
										}}
									>
										{t("Open Settings")}
									</div>
									<div className="menu-item" onClick={() => invoke("restart_bloom")}>
										{t("Restart Bloom")}
									</div>
									<div
										className="menu-item"
										onClick={() => {
											handleClearIconCache();
											closeMenu();
										}}
									>
										{t("Clear Icon Cache")}
									</div>
									<div className="menu-divider" />
									<div className="menu-item quit" onClick={() => invoke("quit_bloom")}>
										{t("Quit Bloom")}
									</div>
								</div>
							</div>
						</>
					)}
				</div>
			)}

			<input
				id="icon-file-input"
				type="file"
				accept=".png,.ico,.jpg,.jpeg,.svg,.bmp"
				style={{ display: "none" }}
				onChange={handleIconFileSelect}
			/>

			<AnimatePresence>
				{showAddPopup && (
					<AddAppPopup
						containerRef={popupRef}
						onClose={closePopup}
						onAdd={(app: AppInfo) => {
							togglePin(app);
							closePopup();
						}}
						scale={scale}
					/>
				)}
			</AnimatePresence>

			<AnimatePresence>
				{toast && (
					<motion.div
						className="dock-toast"
						initial={{ opacity: 0, y: 10 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 10 }}
						transition={{ duration: 0.2 }}
						style={{ zoom: scale }}
					>
						{toast}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
});

// Quick-access buttons that stand in for the native Windows notification area
// (hidden-icons chevron, network, sound, notifications). Each one asks the
// backend to open the matching native Windows flyout.
type NetworkKind = "wifi" | "ethernet" | "other" | "none";

interface NetworkStatus {
	kind: NetworkKind;
	internet: boolean;
	signal: number;
}

function networkTitle(kind: NetworkKind, signal: number): string {
	switch (kind) {
		case "wifi":
			return signal > 0 ? translate("Network (Wi-Fi, {n}%)", { n: signal }) : "Network (Wi-Fi)";
		case "ethernet":
			return translate("Network (Ethernet)");
		case "none":
			return translate("No internet");
		default:
			return translate("Network");
	}
}

// Mirrors the native Windows icons: Wi-Fi bars that follow the signal strength
// for wireless, a wired "monitor with cable" icon for Ethernet, and a globe with
// an X when there is no internet.
function NetworkIcon({ kind, signal }: { kind: NetworkKind; signal: number }) {
	if (kind === "none") {
		return (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<circle cx="11" cy="11" r="8" />
				<path d="M3 11h16" />
				<path d="M11 3a12 12 0 0 1 0 16a12 12 0 0 1 0-16" />
				<path d="M15.5 15.5l6 6" stroke="#ff5c5c" strokeWidth="2.6" />
				<path d="M21.5 15.5l-6 6" stroke="#ff5c5c" strokeWidth="2.6" />
			</svg>
		);
	}
	if (kind === "ethernet" || kind === "other") {
		return (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<rect x="3" y="4" width="18" height="12" rx="2" />
				<rect x="14" y="7" width="4" height="3" rx="0.6" />
				<path d="M12 16v4" />
				<path d="M8 20h8" />
			</svg>
		);
	}
	// Wi-Fi: 0 = dot only, 3 = full strength. Unknown signal (0) shows full bars.
	const level = signal <= 0 ? 3 : signal >= 70 ? 3 : signal >= 45 ? 2 : signal >= 20 ? 1 : 0;
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M1.42 9a16 16 0 0 1 21.16 0" opacity={level >= 3 ? 1 : 0.3} />
			<path d="M5 12.55a11 11 0 0 1 14.08 0" opacity={level >= 2 ? 1 : 0.3} />
			<path d="M8.53 16.11a6 6 0 0 1 6.95 0" opacity={level >= 1 ? 1 : 0.3} />
			<line x1="12" y1="20" x2="12.01" y2="20" />
		</svg>
	);
}

const TRAY_BUTTONS: {
	id: string;
	title: string;
	command: string;
	icon?: ReactElement;
}[] = [
	{
		id: "tray",
		title: "Hidden icons",
		command: "open_system_tray",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				strokeWidth="2.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<polyline points="6 15 12 9 18 15" />
			</svg>
		)
	},
	{
		id: "network",
		title: "Network",
		command: "open_wifi_settings"
	},
	{
		id: "sound",
		title: "Sound",
		command: "open_sound_settings",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
				<path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
				<path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
			</svg>
		)
	},
	{
		id: "notifications",
		title: "Notifications",
		command: "open_notification_center",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
				<path d="M13.73 21a2 2 0 0 1-3.46 0" />
			</svg>
		)
	}
];

const DockTrayButtons = memo(function DockTrayButtons() {
	const t = useT();
	const [network, setNetwork] = useState<{ kind: NetworkKind; signal: number }>({
		kind: "wifi",
		signal: 0
	});

	// Keep the network icon in sync with the real connection state.
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			try {
				const status = await invoke<NetworkStatus>("get_network_status");
				if (!cancelled) {
					setNetwork((prev) =>
						prev.kind === status.kind && prev.signal === status.signal
							? prev
							: { kind: status.kind, signal: status.signal }
					);
				}
			} catch {
				// keep the last known icon
			}
		};
		refresh();
		const interval = setInterval(refresh, 3000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	return (
		<>
			<div className="dock-tray-divider" />
			<div className="dock-tray-group">
				{TRAY_BUTTONS.map((btn) => (
					<div
						key={btn.id}
						className="dock-icon-wrapper dock-tray-button"
						onClick={(e) => {
							e.stopPropagation();
							// The hidden-icons popup is placed right above this button.
							const args =
								btn.id === "tray"
									? (() => {
											const rect = e.currentTarget.getBoundingClientRect();
											return {
												anchorX: rect.left + rect.width / 2,
												anchorY: rect.top
											};
										})()
									: undefined;
							// Wired connections open the Ethernet page instead of the Wi-Fi list.
							const command =
								btn.id === "network" && network.kind === "ethernet"
									? "open_ethernet_settings"
									: btn.command;
							invoke(command, args).catch((err) => console.error(`Failed to run ${command}:`, err));
						}}
					>
						<div className="dock-icon">
							{btn.id === "network" ? (
								<NetworkIcon kind={network.kind} signal={network.signal} />
							) : (
								btn.icon
							)}
						</div>
						<div className="tooltip">
							{btn.id === "network" ? networkTitle(network.kind, network.signal) : t(btn.title)}
						</div>
					</div>
				))}
			</div>
		</>
	);
});

function AddAppPopup({
	onClose,
	onAdd,
	containerRef,
	scale
}: {
	onClose: () => void;
	onAdd: (app: AppInfo) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	scale: number;
}) {
	const t = useT();
	const [apps, setApps] = useState<AppInfo[]>([]);
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const [listIcons, setListIcons] = useState<Record<string, string>>({});
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search), 150);
		return () => clearTimeout(timer);
	}, [search]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Reset selection when search changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [debouncedSearch]);

	// Scroll selected item into view
	useEffect(() => {
		if (!listRef.current) return;
		const row = listRef.current.children[selectedIndex] as HTMLElement | undefined;
		if (row) row.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	useEffect(() => {
		const load = async () => {
			try {
				const res = await invoke<AppInfo[]>("get_installed_apps");
				setApps(res.sort((a, b) => a.name.localeCompare(b.name)));
			} finally {
				setLoading(false);
			}
		};
		load();
	}, []);

	const filtered = useMemo(() => {
		const s = debouncedSearch.toLowerCase();
		if (!s) return apps.slice(0, 20);
		return apps.filter((a) => a.name.toLowerCase().includes(s)).slice(0, 50);
	}, [apps, debouncedSearch]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (filtered[selectedIndex]) {
					onAdd(filtered[selectedIndex]);
				}
			}
		};
		const handleMouseDown = (e: MouseEvent) => {
			const popup = containerRef.current;
			if (popup && !popup.contains(e.target as Node)) {
				onClose();
			}
		};
		const handleBlur = () => onClose();
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("blur", handleBlur);
		document.addEventListener("mousedown", handleMouseDown, true);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("blur", handleBlur);
			document.removeEventListener("mousedown", handleMouseDown, true);
		};
	}, [onClose, containerRef, filtered, selectedIndex, onAdd]);

	useEffect(() => {
		let active = true;
		const fetchVisibleIcons = async () => {
			let batch: Record<string, string> = {};
			let count = 0;
			for (const app of filtered) {
				if (!active) break;
				if (!listIcons[app.path]) {
					await new Promise((r) => setTimeout(r, 20));
					try {
						const icon = await invoke<string | null>("get_app_icon", {
							path: app.path
						});
						if (icon && active) {
							batch[app.path] = icon;
							count++;
							if (count >= 6) {
								setListIcons((prev) => ({ ...prev, ...batch }));
								batch = {};
								count = 0;
							}
						}
					} catch (err) {
						console.error(err);
					}
				}
			}
			if (active && count > 0) setListIcons((prev) => ({ ...prev, ...batch }));
		};
		fetchVisibleIcons();
		return () => {
			active = false;
		};
	}, [filtered]);

	return (
		<div className="add-popup-anchor" style={{ zoom: scale }}>
			<motion.div
				ref={containerRef}
				className="add-app-popup"
				style={{ transformOrigin: "bottom center" }}
				initial={{ opacity: 0, scaleY: 0 }}
				animate={{ opacity: 1, scaleY: 1 }}
				exit={{ opacity: 0, scaleY: 0 }}
				transition={{
					opacity: { duration: 0.15 },
					scaleY: { type: "spring", stiffness: 500, damping: 30, mass: 0.8 }
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="popup-search-row">
					<svg
						className="popup-search-icon"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						ref={inputRef}
						type="text"
						className="popup-search-input"
						placeholder={t("Search apps...")}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				<div className="popup-apps-scroll" ref={listRef}>
					{loading ? (
						<div className="popup-loading">
							<div className="popup-spinner" />
						</div>
					) : filtered.length > 0 ? (
						filtered.map((app, idx) => {
							const icon = listIcons[app.path];
							return (
								<div
									key={app.path}
									className={`popup-app-row${idx === selectedIndex ? " selected" : ""}`}
									onClick={() => onAdd(app)}
									onMouseEnter={() => setSelectedIndex(idx)}
								>
									<div className="popup-app-icon">
										{icon ? (
											<img src={icon} alt="" draggable={false} />
										) : (
											<span className="popup-app-initial">{app.name[0]}</span>
										)}
									</div>
									<span className="popup-app-name">{app.name}</span>
									<span className="popup-app-pin">+</span>
								</div>
							);
						})
					) : (
						<div className="popup-empty">{t("No results")}</div>
					)}
				</div>
			</motion.div>
		</div>
	);
}

export default Dock;
