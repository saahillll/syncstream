export const metadata = { title: "SyncStream" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0f1117", color: "#e6e8ee", fontFamily: "system-ui" }}>
        {children}
      </body>
    </html>
  );
}
