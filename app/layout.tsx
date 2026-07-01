import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Destiny Fashion Editor",
  description: "3D Destiny 2 character & fashion editor — armor, weapons, shaders in the browser.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
