import type { Severity } from "@/lib/types/section";
import { Badge } from "@/components/ui/badge";

export function SeverityBadge({ severity }: { severity: Severity }) {
	return <Badge variant={severity}>{severity}</Badge>;
}
