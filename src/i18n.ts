import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Language = "en" | "pt";
export const LANGUAGE_KEY = "bloom-language";

function detect(): Language {
	try {
		const saved = localStorage.getItem(LANGUAGE_KEY);
		if (saved === "pt" || saved === "en") return saved;
	} catch {
		/* ignore */
	}
	return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("pt")
		? "pt"
		: "en";
}

let current: Language = detect();
const listeners = new Set<() => void>();

function apply(lang: Language) {
	if (lang === current) return;
	current = lang;
	try {
		document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
	} catch {
		/* ignore */
	}
	listeners.forEach((l) => l());
}

export function getLanguage(): Language {
	return current;
}

/** Locale string for Intl / toLocale* calls. */
export function getLocale(): string {
	return current === "pt" ? "pt-BR" : "en-US";
}

/** Change the language, persist it and tell every window. */
export function setLanguage(lang: Language) {
	try {
		localStorage.setItem(LANGUAGE_KEY, lang);
	} catch {
		/* ignore */
	}
	apply(lang);
	invoke("save_setting", { key: LANGUAGE_KEY, value: lang }).catch(() => {});
}

function fromValue(value: unknown): Language | null {
	return value === "pt" || value === "en" ? value : null;
}

// Keep every window in sync (settings window changes -> dock / notch update).
if (typeof window !== "undefined") {
	listen<{ key: string; value: any }>("settings-changed", (e) => {
		if (e.payload.key !== LANGUAGE_KEY) return;
		const lang = fromValue(e.payload.value);
		if (lang) {
			try {
				localStorage.setItem(LANGUAGE_KEY, lang);
			} catch {
				/* ignore */
			}
			apply(lang);
		}
	}).catch(() => {});
	listen<{ key: string; value: any }>("settings-external-changed", (e) => {
		if (e.payload.key !== LANGUAGE_KEY) return;
		const lang = fromValue(e.payload.value);
		if (lang) apply(lang);
	}).catch(() => {});
	invoke<Record<string, any>>("load_settings")
		.then((s) => {
			const lang = fromValue(s?.[LANGUAGE_KEY]);
			if (lang) apply(lang);
			else if (s && !(LANGUAGE_KEY in s)) {
				// First run: remember the detected language (also used by the tray menu).
				invoke("save_setting", { key: LANGUAGE_KEY, value: current }).catch(() => {});
			}
		})
		.catch(() => {});
	try {
		document.documentElement.lang = current === "pt" ? "pt-BR" : "en";
	} catch {
		/* ignore */
	}
}

const pt: Record<string, string> = {
	"24-Hour Time": "Relógio 24 horas",
	"Adaptive Accent": "Cor adaptativa",
	"Adaptive Mode": "Modo adaptativo",
	"Add App to Dock...": "Adicionar app à dock...",
	"Ambient Glow": "Brilho ambiente",
	"App": "Aplicativo",
	"Audio Output": "Saída de áudio",
	"Auto Update": "Atualização automática",
	"Background Brightness": "Brilho do fundo",
	"Background Opacity": "Opacidade do fundo",
	"Battery": "Bateria",
	"Behavior": "Comportamento",
	"Bloom Dock": "Dock do Bloom",
	"Bloom Options": "Opções do Bloom",
	"Bloom Settings": "Configurações do Bloom",
	"Bloom brightness overlay": "Sobreposição de brilho do Bloom",
	"Bloom is up to date": "O Bloom está atualizado",
	"Bloom volume overlay": "Sobreposição de volume do Bloom",
	"Bluetooth": "Bluetooth",
	"Bounce on Launch": "Pular ao abrir",
	"Brightness": "Brilho",
	"Brightness HUD": "HUD de brilho",
	"CPU": "CPU",
	"CPU Usage": "Uso da CPU",
	"Calendar & Timer": "Calendário e Timer",
	"Change Icon...": "Alterar ícone...",
	"Charging": "Carregando",
	"Check for Updates": "Verificar atualizações",
	"Checking...": "Verificando...",
	"Choose expanded player style": "Escolha o estilo do player expandido",
	"Choose how the dock appears": "Escolha como a dock aparece",
	"Choose how the notch appears": "Escolha como o notch aparece",
	"Choose layout background color": "Escolha a cor de fundo do layout",
	"Choose the app language": "Escolha o idioma do aplicativo",
	"Clear": "Limpo",
	"Clear Icon Cache": "Limpar cache de ícones",
	"Clear city": "Limpar cidade",
	"Click to edit": "Clique para editar",
	"Click to open Settings": "Clique para abrir as Configurações",
	"Click to set a duration": "Clique para definir uma duração",
	"Close Settings": "Fechar Configurações",
	"Close Window": "Fechar janela",
	"Color Saturation": "Saturação da cor",
	"Colored glow behind expanded album art": "Brilho colorido atrás da capa do álbum expandida",
	"Colorful": "Colorido",
	"Compact Glow": "Brilho compacto",
	"Compact Mode": "Modo compacto",
	"Configure visual styling": "Configure o estilo visual",
	"Connected": "Conectado",
	"Currently running v{v}": "Executando a v{v}",
	"Custom Color": "Cor personalizada",
	"Custom Theme Color": "Cor do tema personalizada",
	"Custom icon": "Ícone personalizado",
	"Cycle dock mode: Fixed / Smart / Peek": "Alternar modo da dock: Fixo / Inteligente / Espiar",
	"Cycle notch mode: Fixed / Smart / Peek": "Alternar modo do notch: Fixo / Inteligente / Espiar",
	"Dark (Translucent)": "Escuro (translúcido)",
	"Data": "Dados",
	"Decrease Scale": "Diminuir escala",
	"Disk": "Disco",
	"Dismiss": "Dispensar",
	"Display": "Tela",
	"Display {n}": "Tela {n}",
	"Dock": "Dock",
	"Dock Mode": "Modo da Dock",
	"Downloading Update...": "Baixando atualização...",
	"Drizzle": "Garoa",
	"Drop here": "Solte aqui",
	"Enable productivity split-view": "Ativa a visão dividida de produtividade",
	"Energy Saver": "Economia de energia",
	"Exit application completely": "Sair completamente do aplicativo",
	"Experimental: also show the dock on every extra monitor": "Experimental: mostra a dock também em todos os monitores extras",
	"Export Settings": "Exportar configurações",
	"Exported!": "Exportado!",
	"Exporting...": "Exportando...",
	"Failed to set icon": "Falha ao definir o ícone",
	"Fixed": "Fixo",
	"Focus / DND": "Foco / Não perturbe",
	"Foggy": "Neblina",
	"Free Disk Space": "Espaço livre em disco",
	"Freezing Drizzle": "Garoa congelante",
	"Freezing Rain": "Chuva congelante",
	"Glow around collapsed thumbnail": "Brilho ao redor da miniatura recolhida",
	"Golden": "Dourado",
	"Hidden icons": "Ícones ocultos",
	"Icon Only": "Somente ícone",
	"Icons bounce while an app is starting": "Os ícones pulam enquanto um app inicia",
	"Icons grow near the pointer, like the macOS Dock": "Os ícones crescem perto do ponteiro, como no Dock do macOS",
	"Import Settings": "Importar configurações",
	"Imported!": "Importado!",
	"Importing...": "Importando...",
	"Increase Scale": "Aumentar escala",
	"Installing...": "Instalando...",
	"Interactive live music widget": "Widget de música interativo",
	"Language": "Idioma",
	"Launch at Login": "Iniciar com o Windows",
	"Learn more": "Saiba mais",
	"Left": "Esquerda",
	"Left-click to toggle, Right-click for Settings": "Clique esquerdo para alternar, direito para Configurações",
	"Light (Translucent)": "Claro (translúcido)",
	"Load settings from a file": "Carregar configurações de um arquivo",
	"Low Battery": "Bateria fraca",
	"Low Battery Alert": "Alerta de bateria fraca",
	"Magnification": "Ampliação",
	"Magnification Size": "Tamanho da ampliação",
	"Media Layout": "Layout de mídia",
	"macOS Open/Close Animation": "Animação de abrir/fechar do macOS",
	"Icons of apps grow in when opened and shrink away when closed": "Os ícones dos apps crescem ao abrir e encolhem ao fechar",
	"Classic": "Clássico",
	"Compact": "Compacto",
	"Mostly Clear": "Predomínio de sol",
	"Music Mode": "Modo música",
	"Net": "Rede",
	"Network": "Rede",
	"Network (Ethernet)": "Rede (Ethernet)",
	"Network (Wi-Fi, {n}%)": "Rede (Wi-Fi, {n}%)",
	"Network Speed": "Velocidade da rede",
	"No internet": "Sem internet",
	"No results": "Nenhum resultado",
	"No updates found": "Nenhuma atualização encontrada",
	"Notch": "Notch",
	"Notch Behavior": "Comportamento do Notch",
	"Notch Mode": "Modo do Notch",
	"Notification Center": "Central de notificações",
	"Notifications": "Notificações",
	"Off": "Desligado",
	"On": "Ligado",
	"On Battery": "Na bateria",
	"Open Bloom automatically": "Abrir o Bloom automaticamente",
	"Open New Instance": "Abrir nova instância",
	"Open Settings": "Abrir Configurações",
	"Open pinned apps with Win+1 through Win+9": "Abra apps fixados com Win+1 até Win+9",
	"Orange": "Laranja",
	"Overcast": "Nublado",
	"Overlays": "Sobreposições",
	"Partly Cloudy": "Parcialmente nublado",
	"Pause": "Pausar",
	"Paused · ": "Pausado · ",
	"Peek": "Espiar",
	"Pin to Dock": "Fixar na dock",
	"Play a chime when the timer finishes": "Toca um som quando o timer termina",
	"Quit Bloom": "Sair do Bloom",
	"RAM": "RAM",
	"RAM Usage": "Uso da RAM",
	"Rain Showers": "Pancadas de chuva",
	"Rainy": "Chuvoso",
	"Reinitialize all components": "Reinicia todos os componentes",
	"Remove": "Remover",
	"Remove icon background and padding": "Remove o fundo e o espaçamento do ícone",
	"Replace Windows taskbar": "Substitui a barra de tarefas do Windows",
	"Reset": "Redefinir",
	"Reset Icon": "Redefinir ícone",
	"Reset to default": "Voltar ao padrão",
	"Restart": "Reiniciar",
	"Restart Bloom": "Reiniciar o Bloom",
	"Resume": "Retomar",
	"Right": "Direita",
	"Rounded top edges": "Bordas superiores arredondadas",
	"Save settings to a file": "Salvar configurações em um arquivo",
	"Screen Corners": "Cantos da tela",
	"Search apps...": "Buscar apps...",
	"Search city...": "Buscar cidade...",
	"Set duration": "Definir duração",
	"Set timer duration": "Definir duração do timer",
	"Settings": "Configurações",
	"Show App Previews": "Mostrar prévias dos apps",
	"Show green dot when update available": "Mostra um ponto verde quando há atualização",
	"Show hidden icons, network, sound and notification buttons in the dock": "Mostra na dock os botões de ícones ocultos, rede, som e notificações",
	"Show on All Monitors": "Mostrar em todos os monitores",
	"Show on Edge Hover": "Mostrar ao passar na borda",
	"Show visualizer & artwork when collapsed": "Mostra visualizador e capa quando recolhido",
	"Show window thumbnails on hover": "Mostra miniaturas das janelas ao passar o mouse",
	"Slide in from left edge": "Desliza a partir da borda esquerda",
	"Slide in from right edge": "Desliza a partir da borda direita",
	"Smart": "Inteligente",
	"Snow Showers": "Pancadas de neve",
	"Snowy": "Neve",
	"Software Updates": "Atualizações de software",
	"Sound": "Som",
	"Start": "Iniciar",
	"Stormy": "Tempestade",
	"Stretch to full width when a window is maximized": "Estica até a largura total quando uma janela está maximizada",
	"Swap side": "Trocar lado",
	"System": "Sistema",
	"System Tray": "Bandeja do sistema",
	"System Tray Buttons": "Botões da bandeja do sistema",
	"Task Manager": "Gerenciador de Tarefas",
	"Theme": "Tema",
	"Theme Mode": "Modo do tema",
	"Time's up": "Tempo esgotado",
	"Timer Sound": "Som do timer",
	"Trigger at {n}%": "Avisar em {n}%",
	"UI & Font Scale": "Escala da interface e fonte",
	"Unknown": "Desconhecido",
	"Unpin from Dock": "Desafixar da dock",
	"Update Available": "Atualização disponível",
	"Update Available (v{v})": "Atualização disponível (v{v})",
	"Update Indicator": "Indicador de atualização",
	"Update automatically on startup": "Atualiza automaticamente ao iniciar",
	"Use 24-hour clock format": "Usa o formato de 24 horas",
	"Volume": "Volume",
	"Volume HUD": "HUD de volume",
	"Weather": "Clima",
	"Weather Status": "Status do clima",
	"Wi-Fi": "Wi-Fi",
	"Widgets": "Widgets",
	"Win+Number Shortcuts": "Atalhos Win+número",
	"ends {time}": "termina às {time}",
	"General": "Geral",
	"Appearance": "Aparência",
	"About": "Sobre",
	"Auto-detect location": "Detectar localização automaticamente",
	"Click to install and restart": "Clique para instalar e reiniciar",
	"Adjust theme transparency ({n}%)": "Ajuste a transparência do tema ({n}%)",
	"Adjust theme color vibrancy ({n}%)": "Ajuste a vivacidade das cores do tema ({n}%)",
	"Adjust background lightness ({n}%)": "Ajuste a claridade do fundo ({n}%)",
	"Adjust desktop size ({n}%)": "Ajuste o tamanho da área de trabalho ({n}%)",
	"How much icons grow ({n}%)": "Quanto os ícones crescem ({n}%)"
};

/** Translate an English UI string. Supports {name} placeholders. */
export function translate(text: string, vars?: Record<string, string | number>): string {
	let out = current === "pt" ? (pt[text] ?? text) : text;
	if (vars) {
		for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
	}
	return out;
}

function subscribe(cb: () => void) {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** Hook: returns t() and re-renders the component when the language changes. */
export function useT() {
	useSyncExternalStore(subscribe, getLanguage);
	return translate;
}

export function useLanguage(): Language {
	return useSyncExternalStore(subscribe, getLanguage);
}
