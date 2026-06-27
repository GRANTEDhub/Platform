import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GRANTED Platform",
  description: "Internal platform for grant intelligence and firm operations.",
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
