export function SectionHeader({ color, label, description }: {
  color: "green" | "blue";
  label: string;
  description: string;
}) {
  const dotColor = color === "green" ? "bg-green-500" : "bg-blue-500";
  return (
    <div className="flex items-center gap-2 border-b border-zinc-700 pb-1">
      <div className={`h-2 w-2 rounded-full ${dotColor}`} />
      <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{label}</h3>
      <span className="text-[10px] text-zinc-600">{description}</span>
    </div>
  );
}
