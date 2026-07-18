// Room screen. Wired up in milestones M1 to M3:
//   socket connection to the gateway (socket token from rooms service)
//   chat panel, participant list
//   PlayerAdapter mount (YouTube IFrame first, then Drive HTML5 via Picker)
//   sync engine binding from @syncstream/core
export default function RoomPage({ params }: { params: { slug: string } }) {
  return <main style={{ padding: 24 }}>Room: {params.slug}</main>;
}
