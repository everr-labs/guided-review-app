import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
	{
		variants: {
			variant: {
				default: "bg-secondary text-secondary-foreground",
				high: "bg-[oklch(0.32_0.12_27)] text-[oklch(0.92_0.06_27)]",
				medium: "bg-[oklch(0.34_0.1_70)] text-[oklch(0.92_0.06_70)]",
				low: "bg-[oklch(0.32_0.08_220)] text-[oklch(0.9_0.06_220)]",
				outline:
					"border border-border bg-transparent text-muted-foreground",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

export interface BadgeProps
	extends React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
	return (
		<div className={cn(badgeVariants({ variant }), className)} {...props} />
	);
}
