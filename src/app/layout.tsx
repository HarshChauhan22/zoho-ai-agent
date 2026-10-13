import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zoho Agent',
  description: 'Ask questions about your Zoho CRM and Projects and get structured reports.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
