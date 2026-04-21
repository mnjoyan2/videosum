import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-full font-semibold transition-all disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default:
          "bg-[linear-gradient(180deg,#5aa2ff_0%,#2f75ff_100%)] px-5 py-2.5 text-[15px] text-white shadow-[0_14px_34px_rgba(41,104,255,0.34)] hover:brightness-110",
        secondary:
          "border border-white/8 bg-white/[0.03] px-4 py-2.5 text-[15px] text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:bg-white/[0.06]",
        ghost:
          "px-3 py-2 text-sm text-slate-300 hover:bg-white/[0.05]",
      },
      size: {
        default: "",
        sm: "px-4 py-2 text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
