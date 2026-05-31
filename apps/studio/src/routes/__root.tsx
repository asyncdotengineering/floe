/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';
import * as React from 'react';
import { TooltipProvider } from '~/components/ui/tooltip';
import appCss from '~/styles/app.css?url';

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: 'utf-8' },
			{ name: 'viewport', content: 'width=device-width, initial-scale=1' },
			{ title: 'Floe Studio' },
			{
				name: 'description',
				content: 'Chat UI for any Floe agent. Point at a FLOE_AGENT_URL and talk.',
			},
		],
		links: [{ rel: 'stylesheet', href: appCss }],
	}),
	component: RootComponent,
	notFoundComponent: () => (
		<div className="flex h-screen items-center justify-center p-8 text-center">
			<div>
				<div className="text-lg font-semibold">404 — not found</div>
				<a href="/" className="mt-2 inline-block text-sm underline">
					Back to chat
				</a>
			</div>
		</div>
	),
});

function RootComponent(): React.ReactElement {
	return (
		<RootDocument>
			<TooltipProvider delayDuration={250}>
				<Outlet />
			</TooltipProvider>
		</RootDocument>
	);
}

function RootDocument({ children }: { children: React.ReactNode }): React.ReactElement {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			{/* suppressHydrationWarning silences false positives from
			    browser extensions (ColorZilla, Grammarly, etc.) that
			    inject attributes on <body> after the server HTML is sent. */}
			<body className="min-h-screen antialiased" suppressHydrationWarning>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
