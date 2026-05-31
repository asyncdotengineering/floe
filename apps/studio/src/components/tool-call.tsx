'use client';
import * as React from 'react';
import { CheckCircle2Icon, ChevronDownIcon, Loader2Icon, XCircleIcon, WrenchIcon } from 'lucide-react';
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '~/components/ui/collapsible';
import { cn } from '~/lib/utils';

export interface ToolCallData {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	durationMs?: number | null;
	status: 'running' | 'done' | 'error';
}

export function ToolCall({ data }: { data: ToolCallData }): React.ReactElement {
	const [open, setOpen] = React.useState(false);
	const icon =
		data.status === 'running' ? (
			<Loader2Icon className="size-3.5 animate-spin text-amber-600" />
		) : data.status === 'error' ? (
			<XCircleIcon className="size-3.5 text-red-600" />
		) : (
			<CheckCircle2Icon className="size-3.5 text-emerald-600" />
		);

	const label =
		data.status === 'running'
			? 'running…'
			: data.durationMs != null
				? `${data.durationMs}ms`
				: data.status;

	return (
		<Collapsible open={open} onOpenChange={setOpen} className="my-1.5 max-w-full">
			<CollapsibleTrigger
				className={cn(
					'flex w-full items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-left text-xs transition hover:bg-muted',
				)}
			>
				<WrenchIcon className="size-3.5 text-muted-foreground" />
				<span className="font-mono text-foreground">{data.toolName}</span>
				<span className="text-muted-foreground">·</span>
				{icon}
				<span className="text-muted-foreground">{label}</span>
				<span className="flex-1" />
				<ChevronDownIcon
					className={cn(
						'size-3.5 text-muted-foreground transition-transform',
						open && 'rotate-180',
					)}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="overflow-hidden">
				<div className="space-y-1.5 rounded-md border border-t-0 bg-background px-2.5 py-2 text-[11px]">
					{data.args != null && (
						<div>
							<div className="mb-0.5 font-semibold uppercase tracking-wider text-muted-foreground">
								args
							</div>
							<pre className="overflow-x-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug">
								{JSON.stringify(data.args, null, 2)}
							</pre>
						</div>
					)}
					{data.result != null && (
						<div>
							<div className="mb-0.5 font-semibold uppercase tracking-wider text-muted-foreground">
								result
							</div>
							<pre className="overflow-x-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug">
								{typeof data.result === 'string'
									? data.result
									: JSON.stringify(data.result, null, 2)}
							</pre>
						</div>
					)}
					{data.status === 'running' && (
						<div className="text-muted-foreground">Awaiting result…</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

export interface SourceHit {
	source: string;
	count: number;
	topScore?: number | null;
}

export interface FlowStep {
	kind: 'flow_enter' | 'flow_exit' | 'node_enter' | 'node_exit' | 'extraction_submission';
	name: string;
}

export interface FlowData {
	steps: FlowStep[];
}

const STEP_GLYPH: Record<FlowStep['kind'], string> = {
	flow_enter: '▶',
	flow_exit: '◀',
	node_enter: '·',
	node_exit: '◦',
	extraction_submission: '✓',
};

export function FlowBreadcrumb({ data }: { data: FlowData }): React.ReactElement | null {
	if (!data.steps || data.steps.length === 0) return null;
	return (
		<div className="my-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
			<span className="font-semibold uppercase tracking-wider">Flow</span>
			<span>·</span>
			{data.steps.map((s, i) => (
				<span key={`${s.kind}-${s.name}-${i}`} className="inline-flex items-center gap-1">
					{i > 0 && <span className="text-muted-foreground/60">›</span>}
					<span
						className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono"
						title={s.kind}
					>
						<span className="mr-1 text-muted-foreground/70">{STEP_GLYPH[s.kind]}</span>
						{s.name}
					</span>
				</span>
			))}
		</div>
	);
}

export function SourcesInline({ items }: { items: SourceHit[] }): React.ReactElement | null {
	if (items.length === 0) return null;
	const total = items.reduce((n, s) => n + (s.count || 0), 0);
	return (
		<div className="my-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
			<span className="font-semibold uppercase tracking-wider">Sources</span>
			<span>·</span>
			<span>{total} chunks across {items.length}</span>
			<div className="flex flex-wrap gap-1">
				{items.map((s) => (
					<span
						key={s.source}
						className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono"
						title={s.topScore ? `topScore ${s.topScore.toFixed(2)}` : ''}
					>
						{s.source} <span className="text-muted-foreground/70">×{s.count}</span>
					</span>
				))}
			</div>
		</div>
	);
}
