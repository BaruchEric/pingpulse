# NovaMini (De Soto Laundromat) — Network Analysis

**Date:** 2026-03-25 | **Client:** NovaMini v1.0.4 | **Location:** De Soto

---

## Current Network Topology

```
                        ┌─────────────────────┐
                        │   T-Mobile 5G UC     │
                        │   (n41 mid-band)     │
                        └──────────┬───────────┘
                                   │
                        ┌──────────┴───────────┐
                        │  Inseego FX4100       │
                        │  5G Gateway           │
                        │  192.168.1.1          │
                        │                       │
                        │  - NAT for ALL traffic│
                        │  - DHCP (1.2-1.254)   │
                        │  - WiFi ON (unused?)  │
                        │  - BOTTLENECK         │
                        └──────────┬───────────┘
                                   │ Ethernet
                        ┌──────────┴───────────┐
                        │     Switch / Hub      │
                        └──┬─────┬─────┬────┬──┘
                           │     │     │    │
              ┌────────────┘     │     │    └────────────┐
              │                  │     │                  │
   ┌──────────┴────────┐  ┌─────┴─────┴───┐  ┌──────────┴────────┐
   │  TP-Link Deco     │  │  32 Cameras   │  │   Cradlepoint     │
   │  Mesh APs         │  │  + NVR        │  │   Router          │
   │                   │  │               │  │   (ESD-managed)   │
   │  Customer WiFi    │  │  Local record │  │                   │
   │  Staff devices    │  │  Rare remote  │  │  ┌─────────────┐  │
   │                   │  │  viewing      │  │  │ 165 ESD     │  │
   └───────────────────┘  └───────────────┘  │  │ Laundry     │  │
                                             │  │ Machines    │  │
              ┌──────────────────┐           │  │ → Cloud     │  │
              │  NovaMini        │           │  │   MSSQL     │  │
              │  PingPulse v1.0.4│           │  └─────────────┘  │
              │                  │           │                   │
              │  Monitors all    │           │  Built-in 4G LTE  │
              │  paths from here │           │  (failover modem) │
              └──────────────────┘           └───────────────────┘
```

## Failover Mode (when T-Mobile goes down)

```
            ┌─────────────────────┐
            │   T-Mobile FX4100   │
            │       DOWN          │
            └─────────────────────┘

            ┌─────────────────────┐
            │   Cradlepoint       │
            │   4G LTE Backup     │◄──── Direct cellular connection
            │                     │
            │   165 ESD Machines  │──── → Cloud MSSQL (works BETTER)
            └─────────────────────┘

            ❌ Cameras — offline
            ❌ Customer WiFi — offline
            ❌ NovaMini — offline
            ✅ Laundry payments — operational
```

---

## PingPulse Data Summary (Mar 23-26, 2026)

### Ping Statistics (107,952 total pings)

```
Direction        │ Count   │ Avg RTT  │ Min    │ Max      │ Avg Jitter
─────────────────┼─────────┼──────────┼────────┼──────────┼───────────
CF → Client      │ 53,489  │  51 ms   │ 13 ms  │ 6,925 ms │ 27.9 ms
Client → CF      │ 54,456  │ 135 ms   │ 27 ms  │ 5,748 ms │  0.0 ms
─────────────────┼─────────┼──────────┼────────┼──────────┼───────────
                 │         │  2.6x asymmetry ▲  │          │
```

### RTT Distribution

```
 <50ms    ████████████████████░░░░░░░░░░░░░░░░░░░░  34.1%  (36,803)
 50-100   ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░  22.6%  (24,450)
 100-200  ████████████████████████░░░░░░░░░░░░░░░░░  39.1%  (42,265)  ◄ client→CF
 200-500  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   4.1%  ( 4,378)
 500-1s   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   0.04% (    41)
 >1s      ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   0.02% (    17)
```

### Daily Trends

```
         Avg RTT    Max RTT    Jitter    Errors   Alerts
Mar 23   92 ms      2,121 ms   13.3 ms   0        203
Mar 24   99 ms ▲    6,925 ms   17.8 ms   7 ▲      238 ▲   ◄ worst day
Mar 25   87 ms      2,746 ms   10.3 ms   0        168
Mar 26*  102 ms     5,957 ms   14.1 ms   0         50
                                                  ─────
* partial day                              Total:  659
```

### Hourly Pattern (UTC → CDT)

```
Latency ▲
 110 ┤
     │               ╭─╮
 100 ┤    ╭──╮   ╭──╯  ╰╮
     │╭──╯  ╰──╮│       │
  90 ┤│        ╰╯        ╰──╮  ╭──╮
     │╯                      ╰─╯  ╰──╮        ╭──╮
  80 ┤                                ╰───╮╭──╯  ╰──╮  ╭╮
     │                                    ╰╯        ╰──╯╰──
  70 ┤
     └─┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┤
      00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23  UTC
      6p 7p 8p 9p 10p11p12a 1a 2a 3a 4a 5a 6a 7a 8a 9a10a11a12p 1p 2p 3p 4p 5p CDT
      ▲────── evening peak ──────▲              ▲── lowest ──▲
```

### ICMP Probes (healthy — proves 5G signal is fine)

```
Target   │ Count   │ Avg RTT   │ Min      │ Max
─────────┼─────────┼───────────┼──────────┼──────────
1.1.1.1  │ 11,687  │ 39.3 ms   │ 16.0 ms  │ 447 ms
8.8.8.8  │ 11,687  │ 44.5 ms   │ 16.6 ms  │ 424 ms
9.9.9.9  │  3,098  │ 38.5 ms   │ 17.6 ms  │ 581 ms
─────────┼─────────┼───────────┼──────────┼──────────
Loss: 8 timeouts / 26,472 probes = 0.03%  ✅
```

### Speed Tests

```
Type   │ Target │ Count │ Avg DL     │ Avg UL    │ Max DL
───────┼────────┼───────┼────────────┼───────────┼──────────
Full   │ Edge   │   23  │ 196 Mbps   │ 27 Mbps   │ 432 Mbps
Full   │ Worker │   18  │ 143 Mbps   │ 24 Mbps   │ 223 Mbps
Probe  │ Edge   │ 4,261 │  21 Mbps   │ 20 Mbps   │  45 Mbps
Probe  │ Worker │ 4,490 │  17 Mbps   │ 12 Mbps   │  33 Mbps
```

### Extreme Spikes (>1 second)

```
Timestamp (UTC)      │ RTT       │ Direction    │ Time (CDT)
─────────────────────┼───────────┼──────────────┼──────────────
Mar 24 04:19         │ 6,925 ms  │ CF→Client    │ 10:19 PM
Mar 26 04:00         │ 5,957 ms  │ CF→Client    │ 10:00 PM
Mar 26 04:00         │ 5,748 ms  │ Client→CF    │ 10:00 PM
Mar 24 02:43         │ 5,700 ms  │ CF→Client    │  8:43 PM
Mar 26 04:05         │ 5,265 ms  │ Client→CF    │ 10:05 PM
Mar 24 00:41         │ 5,207 ms  │ CF→Client    │  6:41 PM
Mar 26 03:52         │ 4,512 ms  │ Client→CF    │  9:52 PM
Mar 24 01:56         │ 4,374 ms  │ CF→Client    │  7:56 PM
                     all cluster in 6-10 PM CDT (peak laundry hours)
```

---

## Diagnosis

### Root Cause: FX4100 Overloaded

The Inseego FX4100 is a **consumer 5G home gateway** acting as the sole router
for a commercial operation with 200+ devices. Evidence:

1. **Upstream asymmetry (135ms vs 51ms)** — FX4100 NAT processing delays outbound packets
2. **ICMP probes healthy (39-45ms)** — 5G radio link is fine; bottleneck is the device
3. **Device churn every 10-30 seconds** in FX4100 logs — DHCP/NAT table thrashing
4. **Evening spikes to 7 seconds** — peak device activity saturates FX4100 CPU
5. **Cradlepoint LTE failover works better** — bypasses FX4100 entirely

### Contributing Factors

- **Double NAT for ESD machines**: Machine → Cradlepoint NAT → FX4100 NAT → T-Mobile
- **Flat /24 network**: No QoS, no traffic prioritization
- **DHCP pool near capacity**: 253 addresses for 200+ devices
- **FX4100 WiFi active**: May interfere with Deco APs on same channels

---

## Recommendations

### Immediate (done)
- [x] PingPulse alert threshold raised from 100ms → 200ms

### Short-term (no new hardware)
- [ ] Disable FX4100 WiFi (Deco handles all WiFi)
- [ ] Reduce DHCP lease time from 1440min to 120min (free up stale addresses)

### Medium-term (recommended fix)
- [ ] Add business router behind FX4100 (UniFi, Mikrotik, or pfSense)
- [ ] Enable FX4100 IP Passthrough to business router
- [ ] Configure VLANs: ESD (priority), Cameras, Customer WiFi (rate-limited)
- [ ] Enable SQM/fq_codel on business router

### Long-term
- [ ] T-Mobile Business Internet plan (higher tower priority)
- [ ] Secondary ISP (wired) for redundancy
