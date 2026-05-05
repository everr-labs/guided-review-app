import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "@/lib/utils";

export const Command = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
	<CommandPrimitive
		ref={ref}
		className={cn(
			"flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
			className,
		)}
		{...props}
	/>
));
Command.displayName = "Command";

export const CommandInput = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Input>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
	<div className="flex items-center border-b border-border px-3" cmdk-input-wrapper="">
		<CommandPrimitive.Input
			ref={ref}
			className={cn(
				"flex h-10 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	</div>
));
CommandInput.displayName = "CommandInput";

export const CommandList = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.List>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
	<CommandPrimitive.List
		ref={ref}
		className={cn("max-h-[400px] overflow-y-auto overflow-x-hidden", className)}
		{...props}
	/>
));
CommandList.displayName = "CommandList";

export const CommandEmpty = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Empty>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
	<CommandPrimitive.Empty
		ref={ref}
		className="py-6 text-center text-sm text-muted-foreground"
		{...props}
	/>
));
CommandEmpty.displayName = "CommandEmpty";

export const CommandGroup = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Group>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
	<CommandPrimitive.Group
		ref={ref}
		className={cn(
			"overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground",
			className,
		)}
		{...props}
	/>
));
CommandGroup.displayName = "CommandGroup";

export const CommandSeparator = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<CommandPrimitive.Separator
		ref={ref}
		className={cn("-mx-1 h-px bg-border", className)}
		{...props}
	/>
));
CommandSeparator.displayName = "CommandSeparator";

export const CommandItem = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
	<CommandPrimitive.Item
		ref={ref}
		className={cn(
			"relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-hidden data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected='true']:bg-accent data-[selected='true']:text-accent-foreground",
			className,
		)}
		{...props}
	/>
));
CommandItem.displayName = "CommandItem";

export const CommandShortcut = ({
	className,
	...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
	<span
		className={cn(
			"ml-auto text-xs tracking-widest text-muted-foreground",
			className,
		)}
		{...props}
	/>
);
