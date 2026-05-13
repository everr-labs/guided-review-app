import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function MarkdownViewer({
	markdown,
	className,
}: {
	markdown: string;
	className?: string;
}) {
	const components = useMemo<Components>(
		() => ({
			a: ({ href, children, ...props }) => {
				return (
					<a
						href={href}
						target="_blank"
						rel="noreferrer"
						className="text-primary underline-offset-4 hover:underline"
						{...props}
					>
						{children}
					</a>
				);
			},
			blockquote: ({ className: blockquoteClassName, ...props }) => (
				<blockquote
					className={cn(
						"my-2 border-l-2 border-border pl-3 text-muted-foreground",
						blockquoteClassName,
					)}
					{...props}
				/>
			),
			code: ({ className: codeClassName, ...props }) => (
				<code
					className={cn(
						"rounded bg-muted/70 px-1 py-0.5 font-mono text-[0.9em]",
						codeClassName,
					)}
					{...props}
				/>
			),
			h1: ({ className: headingClassName, ...props }) => (
				<h1
					className={cn("mb-2 mt-3 text-xl font-semibold", headingClassName)}
					{...props}
				/>
			),
			h2: ({ className: headingClassName, ...props }) => (
				<h2
					className={cn("mb-2 mt-3 text-lg font-semibold", headingClassName)}
					{...props}
				/>
			),
			h3: ({ className: headingClassName, ...props }) => (
				<h3
					className={cn("mb-1.5 mt-3 text-base font-semibold", headingClassName)}
					{...props}
				/>
			),
			hr: ({ className: ruleClassName, ...props }) => (
				<hr className={cn("my-3 border-border", ruleClassName)} {...props} />
			),
			input: ({ className: inputClassName, ...props }) => (
				<input className={cn("mr-1.5 align-middle", inputClassName)} {...props} />
			),
			li: ({ className: itemClassName, ...props }) => (
				<li className={cn("my-1", itemClassName)} {...props} />
			),
			ol: ({ className: listClassName, ...props }) => (
				<ol
					className={cn("my-2 list-decimal space-y-1 pl-5", listClassName)}
					{...props}
				/>
			),
			p: ({ className: paragraphClassName, ...props }) => (
				<p
					className={cn("my-2 first:mt-0 last:mb-0", paragraphClassName)}
					{...props}
				/>
			),
			pre: ({ className: preClassName, ...props }) => (
				<pre
					className={cn(
						"my-2 overflow-x-auto rounded-md border border-border bg-background/70 p-3 text-xs",
						preClassName,
					)}
					{...props}
				/>
			),
			table: ({ className: tableClassName, ...props }) => (
				<div className="my-3 overflow-x-auto">
					<table
						className={cn("w-full border-collapse text-xs", tableClassName)}
						{...props}
					/>
				</div>
			),
			td: ({ className: cellClassName, ...props }) => (
				<td
					className={cn("border border-border px-2 py-1 align-top", cellClassName)}
					{...props}
				/>
			),
			th: ({ className: cellClassName, ...props }) => (
				<th
					className={cn(
						"border border-border bg-muted/50 px-2 py-1 text-left font-semibold",
						cellClassName,
					)}
					{...props}
				/>
			),
			ul: ({ className: listClassName, ...props }) => (
				<ul
					className={cn("my-2 list-disc space-y-1 pl-5", listClassName)}
					{...props}
				/>
			),
		}),
		[],
	);

	return (
		<div className={cn("break-words text-sm leading-relaxed", className)}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{markdown}
			</ReactMarkdown>
		</div>
	);
}
