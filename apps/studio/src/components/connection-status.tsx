'use client';
import * as React from 'react';
import { cn } from '~/lib/utils';
import { getAgentUrl } from '~/lib/agent-config';
import { checkAgentHealth, type HealthResult } from '~/lib/health';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';

const POLL_INTERVAL_MS = 10_000;

export function ConnectionStatus(): React.ReactElement {
	const [url, setUrl] = React.useState<string>(() => getAgentUrl());
	const [health, setHealth] = React.useState<HealthResult | null>(null);
	const [pinging, setPinging] = React.useState(true);

	const ping = React.useCallback(async (target: string) => {
		setPinging(true);
		const result = await checkAgentHealth(target);
		setHealth(result);
		setPinging(false);
	}, []);

	React.useEffect(() => {
		// Sync local copy when the settings dialog updates the URL.
		const onChange = (e: Event) => {
			const detail = (e as CustomEvent<{ url: string }>).detail;
			setUrl(detail.url ?? getAgentUrl());
		};
		window.addEventListener('floe-studio:agent-url-changed', onChange);
		return () => window.removeEventListener('floe-studio:agent-url-changed', onChange);
	}, []);

	React.useEffect(() => {
		void ping(url);
		const id = window.setInterval(() => void ping(url), POLL_INTERVAL_MS);
		return () => window.clearInterval(id);
	}, [url, ping]);

	const status = pinging && !health ? 'pinging' : health?.ok ? 'ok' : 'down';
	const dotClass =
		status === 'ok'
			? 'bg-emerald-500'
			: status === 'down'
				? 'bg-red-500'
				: 'bg-amber-400 animate-pulse';
	const label =
		status === 'ok'
			? `connected · ${health?.durationMs}ms`
			: status === 'down'
				? 'unreachable'
				: 'checking…';

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={() => void ping(url)}
					className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted"
					title="Click to re-check"
				>
					<span className={cn('size-2 rounded-full', dotClass)} />
					<span className="font-mono">{label}</span>
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">
				<div className="font-mono text-[11px]">{url}</div>
				{health?.error && <div className="text-[11px] text-red-300">{health.error}</div>}
				{health?.status && (
					<div className="text-[11px]">HTTP {health.status} · {health.durationMs}ms</div>
				)}
				<div className="mt-1 text-[10px] text-muted-foreground">
					Click to recheck · auto-polls every 10s
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
