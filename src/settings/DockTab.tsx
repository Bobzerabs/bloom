import { useState, type ChangeEvent, type CSSProperties } from "react";
import {
	Monitor,
	Eye,
	EyeOff,
	Circle,
	Maximize2,
	Keyboard,
	Sparkles,
	RotateCcw,
	ZoomIn,
	MonitorSmartphone
} from "lucide-react";
import { SettingRow } from "./SettingRow";
import { useT } from "../i18n";

const START_ICON_PRESETS = [
	{ key: "default", src: "/bloom.png", label: "Bloom" },
	{ key: "bloom-colorful", src: "/bloom-colorful.png", label: "Colorful" },
	{ key: "bloom-golden", src: "/bloom-golden.png", label: "Golden" },
	{ key: "bloom-biscuit", src: "/bloom-biscuit.png", label: "Orange" },
	{ key: "windows", src: "/windows.png", label: "Windows" }
];

const startIconTileStyle = (active: boolean): CSSProperties => ({
	width: "48px",
	height: "48px",
	borderRadius: "12px",
	border: active ? "2px solid var(--bloom-accent, #007aff)" : "2px solid rgba(255,255,255,0.1)",
	background: active ? "rgba(0,122,255,0.15)" : "rgba(255,255,255,0.05)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	cursor: "pointer",
	transition: "all 0.15s ease",
	padding: "6px",
	color: "rgba(255,255,255,0.5)"
});

interface DockTabProps {
	dockEnabled: boolean;
	toggleDock: () => void;
	dockMode: string;
	setDockModeValue: (mode: string) => void;
	dockPreviewEnabled: boolean;
	toggleDockPreview: () => void;
	dockIconOnly: boolean;
	toggleDockIconOnly: () => void;
	dockTrayEnabled: boolean;
	toggleDockTray: () => void;
	dockMagnify: boolean;
	toggleDockMagnify: () => void;
	dockMagnifySize: number;
	handleMagnifySizeChange: (val: number) => void;
	dockBounce: boolean;
	toggleDockBounce: () => void;
	dockAllMonitors: boolean;
	toggleDockAllMonitors: () => void;
	dockAdaptive: boolean;
	toggleDockAdaptive: () => void;
	dockWinNumberEnabled: boolean;
	toggleDockWinNumber: () => void;
	startIcon: string;
	handleStartIconChange: (icon: string) => void;
}

export function DockTab({
	dockEnabled,
	toggleDock,
	dockMode,
	setDockModeValue,
	dockPreviewEnabled,
	toggleDockPreview,
	dockIconOnly,
	toggleDockIconOnly,
	dockTrayEnabled,
	toggleDockTray,
	dockMagnify,
	toggleDockMagnify,
	dockMagnifySize,
	handleMagnifySizeChange,
	dockBounce,
	toggleDockBounce,
	dockAllMonitors,
	toggleDockAllMonitors,
	dockAdaptive,
	toggleDockAdaptive,
	dockWinNumberEnabled,
	toggleDockWinNumber,
	startIcon,
	handleStartIconChange
}: DockTabProps) {
	const t = useT();
	const [uploadError, setUploadError] = useState<string | null>(null);

	// Shrinks the picked image to at most 256x256 (PNG, transparency kept) so the
	// setting stays small enough for localStorage and settings.json.
	const shrinkImage = (dataUrl: string, maxSize = 256): Promise<string> =>
		new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				if (!img.width || !img.height) {
					// e.g. an SVG without intrinsic size: keep it as-is
					resolve(dataUrl);
					return;
				}
				const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
				const w = Math.max(1, Math.round(img.width * ratio));
				const h = Math.max(1, Math.round(img.height * ratio));
				const canvas = document.createElement("canvas");
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext("2d");
				if (!ctx) {
					reject(new Error("Canvas not available"));
					return;
				}
				ctx.drawImage(img, 0, 0, w, h);
				resolve(canvas.toDataURL("image/png"));
			};
			img.onerror = () => reject(new Error("Could not read this image"));
			img.src = dataUrl;
		});

	const handleStartIconUpload = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		setUploadError(null);
		const reader = new FileReader();
		reader.onload = async () => {
			try {
				const small = await shrinkImage(reader.result as string);
				handleStartIconChange(`custom:${small}`);
			} catch (err) {
				console.error("Start icon upload failed:", err);
				setUploadError("Could not use this image. Try a PNG, JPG, ICO or SVG file.");
			}
		};
		reader.onerror = () => setUploadError("Could not read this file.");
		reader.readAsDataURL(file);
	};

	return (
		<>
			<div className="setting-group-label">{t("Dock")}</div>
			<div className="setting-group">
				<SettingRow icon={Monitor} label="Bloom Dock" desc="Replace Windows taskbar">
					<label className="toggle-switch">
						<input type="checkbox" checked={dockEnabled} onChange={toggleDock} />
						<span className="slider"></span>
					</label>
				</SettingRow>

				{dockEnabled && (
					<>
						<SettingRow
							icon={dockMode === "fixed" ? EyeOff : Eye}
							label="Behavior"
							desc="Choose how the dock appears"
						>
							<select
								className="settings-select"
								value={dockMode}
								onChange={(e) => setDockModeValue(e.target.value)}
							>
								<option value="fixed">{t("Fixed")}</option>
								<option value="smart">{t("Smart")}</option>
								<option value="peek">{t("Peek")}</option>
							</select>
						</SettingRow>

						<SettingRow icon={Eye} label="Show App Previews" desc="Show window thumbnails on hover">
							<label className="toggle-switch">
								<input type="checkbox" checked={dockPreviewEnabled} onChange={toggleDockPreview} />
								<span className="slider"></span>
							</label>
						</SettingRow>

						<SettingRow
							icon={Eye}
							label="System Tray Buttons"
							desc="Show hidden icons, network, sound and notification buttons in the dock"
						>
							<label className="toggle-switch">
								<input type="checkbox" checked={dockTrayEnabled} onChange={toggleDockTray} />
								<span className="slider"></span>
							</label>
						</SettingRow>

						<SettingRow
							icon={ZoomIn}
							label="Magnification"
							desc="Icons grow near the pointer, like the macOS Dock"
						>
							<label className="toggle-switch">
								<input type="checkbox" checked={dockMagnify} onChange={toggleDockMagnify} />
								<span className="slider"></span>
							</label>
						</SettingRow>

						{dockMagnify && (
							<SettingRow
								icon={ZoomIn}
								label="Magnification Size"
								desc={t("How much icons grow ({n}%)", { n: Math.round(dockMagnifySize * 100) })}
							>
								<input
									type="range"
									min="1.2"
									max="2.0"
									step="0.1"
									value={dockMagnifySize}
									onChange={(e) => handleMagnifySizeChange(parseFloat(e.target.value))}
									className="settings-slider"
								/>
							</SettingRow>
						)}

						<SettingRow
							icon={Sparkles}
							label="Bounce on Launch"
							desc="Icons bounce while an app is starting"
						>
							<label className="toggle-switch">
								<input type="checkbox" checked={dockBounce} onChange={toggleDockBounce} />
								<span className="slider"></span>
							</label>
						</SettingRow>

						<SettingRow
							icon={MonitorSmartphone}
							label="Show on All Monitors"
							desc="Experimental: also show the dock on every extra monitor"
						>
							<label className="toggle-switch">
								<input
									type="checkbox"
									checked={dockAllMonitors}
									onChange={toggleDockAllMonitors}
								/>
								<span className="slider"></span>
							</label>
						</SettingRow>

						<SettingRow
							icon={Circle}
							label="Icon Only"
							desc="Remove icon background and padding"
							divider={false}
						>
							<label className="toggle-switch">
								<input type="checkbox" checked={dockIconOnly} onChange={toggleDockIconOnly} />
								<span className="slider"></span>
							</label>
						</SettingRow>

						<SettingRow
							icon={Keyboard}
							label="Win+Number Shortcuts"
							desc="Open pinned apps with Win+1 through Win+9"
							divider={dockMode === "fixed"}
						>
							<label className="toggle-switch">
								<input
									type="checkbox"
									checked={dockWinNumberEnabled}
									onChange={toggleDockWinNumber}
								/>
								<span className="slider"></span>
							</label>
						</SettingRow>

						{dockMode === "fixed" && (
							<SettingRow
								icon={Maximize2}
								label="Adaptive Mode"
								desc="Stretch to full width when a window is maximized"
								divider={false}
							>
								<label className="toggle-switch">
									<input type="checkbox" checked={dockAdaptive} onChange={toggleDockAdaptive} />
									<span className="slider"></span>
								</label>
							</SettingRow>
						)}

						<div className="setting-divider" />
						<div
							className="setting-item"
							style={{ flexDirection: "column", alignItems: "flex-start", gap: "10px" }}
						>
							<div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%" }}>
								<div className="setting-icon-bg">
									<Sparkles size={14} strokeWidth={1.5} />
								</div>
								<div className="setting-info">
									<span className="setting-label">Start Menu Icon</span>
									<span className="setting-desc">Choose the dock start button icon</span>
								</div>
							</div>
							<div style={{ display: "flex", gap: "8px", flexWrap: "wrap", paddingLeft: "34px" }}>
								{START_ICON_PRESETS.map((icon) => (
									<div
										key={icon.key}
										onClick={() => handleStartIconChange(icon.key)}
										style={startIconTileStyle(startIcon === icon.key)}
										title={icon.label}
									>
										<img
											src={icon.src}
											alt={icon.label}
											style={{ width: "100%", height: "100%", objectFit: "contain" }}
											draggable={false}
										/>
									</div>
								))}
								<div
									onClick={() => document.getElementById("start-icon-file-input")?.click()}
									style={startIconTileStyle(startIcon.startsWith("custom:"))}
									title={t("Custom icon")}
								>
									{startIcon.startsWith("custom:") ? (
										<img
											src={startIcon.replace("custom:", "")}
											alt="Custom"
											style={{
												width: "100%",
												height: "100%",
												objectFit: "contain",
												borderRadius: "8px"
											}}
											draggable={false}
										/>
									) : (
										<span style={{ fontSize: "20px" }}>+</span>
									)}
								</div>
								{startIcon !== "default" && (
									<div
										onClick={() => handleStartIconChange("default")}
										style={startIconTileStyle(false)}
										title={t("Reset to default")}
									>
										<RotateCcw size={18} strokeWidth={1.5} />
									</div>
								)}
							</div>
							<span className="setting-desc" style={{ paddingLeft: "34px" }}>
								Tap + to upload your own image (PNG, JPG, ICO or SVG)
							</span>
							{uploadError && (
								<span
									className="setting-desc"
									style={{ paddingLeft: "34px", color: "#ff6b6b" }}
								>
									{uploadError}
								</span>
							)}
							<input
								id="start-icon-file-input"
								type="file"
								accept=".png,.ico,.jpg,.jpeg,.svg,.bmp"
								style={{ display: "none" }}
								onChange={handleStartIconUpload}
							/>
						</div>
					</>
				)}
			</div>
		</>
	);
}
