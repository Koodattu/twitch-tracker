import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { ChannelProfile } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../api-client";
import { DetailNavigation } from "../../detail-navigation";
import { Avatar, EmptyState } from "../../ui";
import "./channel.css";

export async function generateMetadata({ params }: { params: Promise<{ login: string }> }): Promise<Metadata> {
  return { title: `${(await params).login} channel` };
}

export default async function ChannelLayout({ params, children }: { params: Promise<{ login: string }>; children: ReactNode }) {
  const { login } = await params;
  const channel = await getApiData<ChannelProfile>(`/api/channels/${encodeURIComponent(login)}`, await getPublicApiInit());
  if (channel == null) return <section className="panel"><EmptyState title="Channel unavailable" description="This channel could not be loaded. It may be unavailable or require a different account." action={<Link className="button" href="/">Live streams</Link>} /></section>;
  const name = channel.displayName ?? channel.login ?? login;
  const base = `/channels/${encodeURIComponent(login)}`;
  return <>
    <section className="page-title page-title-wide channel-heading">
      <div className="breadcrumbs"><Link href="/">Live streams</Link><span>/</span><span>Channel</span></div>
      <div className="page-heading-row">
        <div className="identity-heading"><Avatar name={name} src={channel.profileImageUrl} size="large" /><div><span className="eyebrow">Channel analytics</span><h1>{name}</h1></div></div>
        <a className="button button-secondary" href={`https://www.twitch.tv/${encodeURIComponent(channel.login ?? login)}`} target="_blank" rel="noreferrer">Open on Twitch ↗</a>
      </div>
      {channel.description == null || channel.description === "" ? null : <details className="channel-about"><summary>About {name}</summary><p>{channel.description}</p></details>}
    </section>
    <DetailNavigation label="Channel pages" links={[{ path: base, label: "Overview" }, { path: `${base}/streams`, label: "Streams" }, { path: `${base}/data`, label: "Data" }]} />
    {children}
  </>;
}
