import type { SettingRowProps } from "./types";
import { useT } from "../i18n";

export function SettingRow({
	icon: Icon,
	label,
	desc,
	action,
	danger,
	divider = true,
	onClick,
	children
}: SettingRowProps) {
	const t = useT();
	const className = ["setting-item", action ? "action" : "", danger ? "danger" : ""]
		.filter(Boolean)
		.join(" ");

	return (
		<>
			<div className={className} onClick={onClick}>
				<div className="setting-icon-bg">
					<Icon size={14} strokeWidth={1.5} />
				</div>
				<div className="setting-info">
					<span className="setting-label">{typeof label === "string" ? t(label) : label}</span>
					{desc && <span className="setting-desc">{typeof desc === "string" ? t(desc) : desc}</span>}
				</div>
				{children}
			</div>
			{divider && <div className="setting-divider" />}
		</>
	);
}
