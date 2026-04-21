import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "h-11 w-full rounded-[18px] border border-white/10 bg-[linear-gradient(180deg,rgba(55,67,91,0.52),rgba(40,49,66,0.72))] px-4 text-[15px] text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none placeholder:text-slate-400 focus:border-[#4f93ff] focus:ring-4 focus:ring-[#2f75ff]/20",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
