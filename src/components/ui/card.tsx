import * as React from "react";
import { cn } from "@/lib/utils";

export const Card = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn(
			"rounded-md border border-border bg-card text-card-foreground",
			className,
		)}
		{...props}
	/>
));
Card.displayName = "Card";

export const CardHeader = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("flex flex-col gap-1 p-4", className)} {...props} />
);

export const CardTitle = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("text-sm font-semibold leading-none", className)}
		{...props}
	/>
);

export const CardDescription = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("text-xs text-muted-foreground", className)}
		{...props}
	/>
);

export const CardContent = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("px-4 pb-4", className)} {...props} />
);

export const CardFooter = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("flex items-center px-4 pb-4 gap-2", className)}
		{...props}
	/>
);
