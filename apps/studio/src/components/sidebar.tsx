'use client';
import * as React from 'react';
import { PanelLeftIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { ScrollArea } from '~/components/ui/scroll-area';
import { ConnectionStatus } from '~/components/connection-status';
import { SettingsDialog } from '~/components/settings-dialog';
import { cn } from '~/lib/utils';
import {
	deleteThread,
	groupedByRecency,
	listThreads,
	newThread,
	searchThreads,
	type Thread,
} from '~/lib/threads';

interface SidebarProps {
	activeId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	collapsed: boolean;
	onToggleCollapsed: () => void;
	/** Bump this from the parent to force a thread-list refetch (after `touchThread…`). */
	refreshTick: number;
}

export function Sidebar({
	activeId,
	onSelect,
	onNew,
	collapsed,
	onToggleCollapsed,
	refreshTick,
}: SidebarProps): React.ReactElement {
	const [query, setQuery] = React.useState('');
	const [threads, setThreads] = React.useState<Thread[]>([]);

	React.useEffect(() => {
		setThreads(query ? searchThreads(query) : listThreads());
	}, [query, refreshTick, activeId]);

	function handleDelete(id: string, e: React.MouseEvent) {
		e.stopPropagation();
		deleteThread(id);
		setThreads(query ? searchThreads(query) : listThreads());
		if (activeId === id) onNew(); // create a fresh thread so the chat pane isn't empty
	}

	function handleNew() {
		const t = newThread();
		onSelect(t.id);
		onNew();
	}

	if (collapsed) {
		return (
			<aside className="flex w-12 shrink-0 flex-col items-center gap-2 border-r bg-muted/30 py-3">
				<Button
					variant="ghost"
					size="icon"
					onClick={onToggleCollapsed}
					title="Open sidebar"
				>
					<PanelLeftIcon className="size-4" />
				</Button>
				<Button variant="ghost" size="icon" onClick={handleNew} title="New chat">
					<PlusIcon className="size-4" />
				</Button>
			</aside>
		);
	}

	const grouped = groupedByRecency(threads);

	return (
		<aside className="flex w-64 shrink-0 flex-col border-r bg-muted/30">
			<div className="flex items-center justify-between px-3 py-3">
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon"
						onClick={onToggleCollapsed}
						title="Collapse sidebar"
					>
						<PanelLeftIcon className="size-4" />
					</Button>
					<span className="text-sm font-semibold">Floe Studio</span>
				</div>
				<SettingsDialog />
			</div>

			<div className="px-3 pb-2">
				<Button onClick={handleNew} className="w-full justify-start gap-2">
					<PlusIcon className="size-4" /> New chat
				</Button>
			</div>

			<div className="px-3 pb-2">
				<div className="relative">
					<SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
					<Input
						placeholder="Search threads…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="h-9 pl-8 text-sm"
					/>
				</div>
			</div>

			<ScrollArea className="flex-1">
				<nav className="flex flex-col gap-3 px-2 pb-4">
					{grouped.length === 0 && (
						<div className="px-2 py-6 text-center text-xs text-muted-foreground">
							{query ? 'No matches.' : 'No threads yet. Click “New chat”.'}
						</div>
					)}
					{grouped.map(({ bucket, items }) => (
						<section key={bucket}>
							<div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
								{bucket}
							</div>
							<ul>
								{items.map((t) => (
									<li key={t.id}>
										<button
											type="button"
											onClick={() => onSelect(t.id)}
											className={cn(
												'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition',
												activeId === t.id
													? 'bg-accent text-accent-foreground'
													: 'hover:bg-accent/50',
											)}
										>
											<span className="flex-1 truncate">{t.title}</span>
											<button
												type="button"
												onClick={(e) => handleDelete(t.id, e)}
												className="opacity-0 transition group-hover:opacity-100"
												title="Delete thread"
											>
												<Trash2Icon className="size-3.5 text-muted-foreground hover:text-foreground" />
											</button>
										</button>
									</li>
								))}
							</ul>
						</section>
					))}
				</nav>
			</ScrollArea>

			<div className="flex items-center justify-between border-t px-2 py-2">
				<ConnectionStatus />
			</div>
		</aside>
	);
}
