'use client';
import * as React from 'react';
import { SettingsIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import {
	clearAgentUrl,
	getAgentUrl,
	isValidAgentUrl,
	setAgentUrl,
} from '~/lib/agent-config';

const DEFAULT_AGENT_URLS = [
	{ label: 'ops-bot', url: 'http://localhost:3110' },
	{ label: 'hearth-bot', url: 'http://localhost:3120' },
	{ label: 'cedar-health', url: 'http://localhost:3130' },
	{ label: 'knowledge-worker', url: 'http://localhost:3140' },
	{ label: 'chief-of-staff', url: 'http://localhost:3150' },
];

export function SettingsDialog(): React.ReactElement {
	const [open, setOpen] = React.useState(false);
	const [draft, setDraft] = React.useState('');
	const [touched, setTouched] = React.useState(false);

	React.useEffect(() => {
		if (open) {
			setDraft(getAgentUrl());
			setTouched(false);
		}
	}, [open]);

	const isValid = isValidAgentUrl(draft.trim());

	function save() {
		if (!isValid) return;
		setAgentUrl(draft.trim());
		setOpen(false);
		// Reload so the active thread's transport picks up the new URL.
		window.location.reload();
	}

	function reset() {
		clearAgentUrl();
		setOpen(false);
		window.location.reload();
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="ghost" size="icon" title="Settings">
					<SettingsIcon className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Connect to an agent</DialogTitle>
					<DialogDescription>
						The URL of the Floe agent Studio chats with. Any template that
						runs with <code className="rounded bg-muted px-1 py-0.5">openaiCompat: true</code> works.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div>
						<label className="text-xs font-medium text-muted-foreground">
							Agent URL
						</label>
						<Input
							value={draft}
							onChange={(e) => {
								setDraft(e.target.value);
								setTouched(true);
							}}
							placeholder="http://localhost:3110"
							className="mt-1 font-mono text-sm"
						/>
						{touched && !isValid && (
							<div className="mt-1 text-[11px] text-red-600">
								Must be a valid http:// or https:// URL.
							</div>
						)}
					</div>

					<div>
						<div className="mb-1.5 text-xs font-medium text-muted-foreground">
							Or pick a shipped template
						</div>
						<div className="flex flex-wrap gap-1.5">
							{DEFAULT_AGENT_URLS.map((d) => (
								<Button
									key={d.url}
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										setDraft(d.url);
										setTouched(true);
									}}
									className="font-mono text-[11px]"
								>
									{d.label}
								</Button>
							))}
						</div>
					</div>
				</div>

				<DialogFooter className="gap-2 sm:gap-2">
					<Button variant="ghost" onClick={reset}>
						Reset to default
					</Button>
					<div className="flex-1" />
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button onClick={save} disabled={!isValid}>
						Save + reload
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
