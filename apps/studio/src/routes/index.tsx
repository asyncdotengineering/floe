import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Chat } from '~/components/chat';
import { Sidebar } from '~/components/sidebar';
import {
	getActiveThreadId,
	listThreads,
	newThread,
	setActiveThreadId,
} from '~/lib/threads';

export const Route = createFileRoute('/')({
	component: HomePage,
});

function HomePage(): React.ReactElement {
	const [activeId, setActive] = React.useState<string | null>(null);
	const [refreshTick, setRefreshTick] = React.useState(0);
	const [collapsed, setCollapsed] = React.useState(false);

	React.useEffect(() => {
		// On boot: pick the active thread, or fall back to the most recent,
		// or mint a fresh one.
		const stored = getActiveThreadId();
		if (stored) {
			setActive(stored);
			return;
		}
		const all = listThreads();
		if (all.length > 0 && all[0]) {
			setActive(all[0].id);
			setActiveThreadId(all[0].id);
			return;
		}
		const t = newThread();
		setActive(t.id);
	}, []);

	function selectThread(id: string) {
		setActive(id);
		setActiveThreadId(id);
	}

	function createNewThread() {
		const t = newThread();
		setActive(t.id);
		setRefreshTick((n) => n + 1);
	}

	if (!activeId) {
		return (
			<div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
				Loading…
			</div>
		);
	}

	return (
		<div className="flex h-screen min-h-0 bg-background text-foreground">
			<Sidebar
				activeId={activeId}
				onSelect={selectThread}
				onNew={createNewThread}
				collapsed={collapsed}
				onToggleCollapsed={() => setCollapsed((c) => !c)}
				refreshTick={refreshTick}
			/>
			<main className="flex flex-1 flex-col min-h-0">
				{/* key={activeId} forces useChat to remount on thread switch,
				    clearing the in-memory message list so we don't show one
				    thread's history under another's header. */}
				<Chat
					key={activeId}
					threadId={activeId}
					onAfterUserSend={() => setRefreshTick((n) => n + 1)}
				/>
			</main>
		</div>
	);
}
