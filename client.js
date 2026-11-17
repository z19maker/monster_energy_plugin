/**
 * Monster Energy tracker — draggable Web UI can.
 *
 * Lives in the frame-wide `shell.overlay` slot: a small floating can card that
 * shows how many cans were consumed today and the running total. Drag it
 * anywhere; the position is stored in localStorage. Polls the Host's
 * read-only `/monster-tracker/state` route.
 *
 * The can is inline SVG rather than an image URL, so it needs no asset route,
 * data URL, or packaging step.
 */

window.__ModuleLoader__.load({
  id: '@local/monster-tracker',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'monsterTracker'
    const POSITION_KEY = 'dsh.monster-tracker.float.v1'
    const CARD_WIDTH = 116
    const CARD_HEIGHT = 180
    const EDGE = 20
    const dictionaries = {
      en: {
        today: 'today',
        total: 'total',
        unavailable: 'tracker unavailable',
        loading: 'loading',
        dragHint: 'Drag to move · double-click to reset',
      },
      zh: {
        today: '今天',
        total: '总计',
        unavailable: '记录暂不可用',
        loading: '加载中',
        dragHint: '拖动可移动 · 双击复位',
      },
    }
    const english = dictionaries.en
    const fallback = key => english[key] ?? key

    function clampPosition(position) {
      const maxX = Math.max(EDGE, window.innerWidth - CARD_WIDTH - EDGE)
      const maxY = Math.max(EDGE, window.innerHeight - CARD_HEIGHT - EDGE)
      return {
        x: Math.min(Math.max(position.x, EDGE), maxX),
        y: Math.min(Math.max(position.y, EDGE), maxY),
      }
    }

    function defaultPosition() {
      return clampPosition({
        x: EDGE,
        y: window.innerHeight - CARD_HEIGHT - EDGE,
      })
    }

    function readPosition() {
      try {
        const raw = window.localStorage.getItem(POSITION_KEY)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object'
            && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
            return clampPosition({ x: parsed.x, y: parsed.y })
          }
        }
      } catch (error) {
        // A blocked or corrupt store falls back to the default corner.
      }
      return defaultPosition()
    }

    function writePosition(position) {
      try {
        window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
      } catch (error) {
        // The card still moves for this visit when storage is unavailable.
      }
    }

    /** One simple energy-drink can: dark body, silver lid, green lightning bolt. */
    function CanArt(props) {
      return h('svg', {
        viewBox: '0 0 64 96',
        width: 84,
        height: 120,
        'aria-hidden': true,
        focusable: 'false',
        style: {
          display: 'block',
          pointerEvents: 'none',
          opacity: props.dim ? 0.55 : 1,
        },
      },
      h('rect', { x: 14, y: 6, width: 36, height: 84, rx: 8, fill: '#2f3e50' }),
      h('rect', { x: 14, y: 6, width: 36, height: 12, rx: 6, fill: '#a9bccd' }),
      h('rect', { x: 17, y: 9, width: 30, height: 4, rx: 2, fill: '#dce7f2' }),
      h('rect', { x: 14, y: 20, width: 36, height: 2.5, fill: '#57e389' }),
      h('rect', { x: 18, y: 26, width: 3, height: 46, rx: 1.5, fill: '#ffffff', opacity: 0.08 }),
      h('path', { d: 'M37 29 L23 52 H31 L27 69 L43 44 H34 Z', fill: '#57e389' }),
      h('rect', { x: 14, y: 78, width: 36, height: 12, rx: 6, fill: '#243241' }),
      h('rect', { x: 19, y: 74, width: 26, height: 2, rx: 1, fill: '#57e389' }))
    }

    function MonsterCan(props) {
      const t = props.t ?? fallback
      const [counts, setCounts] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [position, setPosition] = React.useState(readPosition)
      const [dragging, setDragging] = React.useState(false)
      const positionRef = React.useRef(position)
      const dragRef = React.useRef(null)
      positionRef.current = position

      React.useEffect(() => {
        let stopped = false
        let controller
        const load = async () => {
          controller?.abort()
          controller = new AbortController()
          try {
            const response = await fetch('/monster-tracker/state', {
              cache: 'no-store',
              credentials: 'same-origin',
              signal: controller.signal,
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (stopped) return
            if (Number.isInteger(data.todayCans) && Number.isInteger(data.totalCans)) {
              setCounts({ todayCans: data.todayCans, totalCans: data.totalCans })
              setFailed(false)
            }
          } catch (error) {
            if (!stopped && error?.name !== 'AbortError') setFailed(true)
          }
        }
        void load()
        const timer = window.setInterval(load, 3000)
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', load)
        return () => {
          stopped = true
          window.clearInterval(timer)
          controller?.abort()
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('focus', load)
        }
      }, [])

      React.useEffect(() => {
        const onResize = () => {
          const next = clampPosition(positionRef.current)
          positionRef.current = next
          setPosition(next)
          writePosition(next)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const moveTo = next => {
        positionRef.current = next
        setPosition(next)
      }

      const onPointerDown = event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        event.preventDefault()
        try { event.currentTarget.focus() } catch (error) {}
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) {}
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          origin: positionRef.current,
        }
        setDragging(true)
      }

      const onPointerMove = event => {
        const active = dragRef.current
        if (active === null || active.pointerId !== event.pointerId) return
        moveTo(clampPosition({
          x: active.origin.x + event.clientX - active.startX,
          y: active.origin.y + event.clientY - active.startY,
        }))
      }

      const finishDrag = event => {
        if (dragRef.current === null) return
        dragRef.current = null
        setDragging(false)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) {}
        writePosition(positionRef.current)
      }

      const resetPosition = () => {
        const next = defaultPosition()
        moveTo(next)
        writePosition(next)
      }

      const onKeyDown = event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          resetPosition()
          return
        }
        const step = event.shiftKey ? 40 : 10
        const deltas = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        }
        const delta = deltas[event.key]
        if (delta === undefined) return
        event.preventDefault()
        const next = clampPosition({
          x: positionRef.current.x + delta[0],
          y: positionRef.current.y + delta[1],
        })
        moveTo(next)
        writePosition(next)
      }

      const loading = counts === null && !failed
      const todayCans = counts?.todayCans ?? 0
      const totalCans = counts?.totalCans ?? 0
      const badge = loading ? '…' : String(todayCans)
      const label = failed
        ? t('unavailable')
        : loading
          ? t('loading')
          : `Monster Energy: ${todayCans} today, ${totalCans} total`
      const lineColor = failed ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)'

      return h('div', {
        'data-monster-tracker': 'float',
        role: 'group',
        tabIndex: 0,
        'aria-label': label,
        title: t('dragHint'),
        onPointerDown,
        onPointerMove,
        onPointerUp: finishDrag,
        onPointerCancel: finishDrag,
        onDoubleClick: resetPosition,
        onKeyDown,
        style: {
          position: 'fixed',
          left: position.x,
          top: position.y,
          width: CARD_WIDTH,
          zIndex: 9000,
          pointerEvents: 'auto',
          touchAction: 'none',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        },
      },
      h('div', {
        style: {
          position: 'relative',
          boxSizing: 'border-box',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          padding: '8px 8px 6px',
          borderRadius: 16,
          border: dragging ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          boxShadow: '0 10px 28px rgba(15, 23, 42, 0.22)',
        },
      },
      h('span', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 96,
          height: 128,
          borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-2)',
          overflow: 'hidden',
        },
      }, h(CanArt, { dim: todayCans === 0 || loading })),
      h('span', {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: 4,
          color: lineColor,
          fontSize: 13,
          lineHeight: '16px',
          fontWeight: 600,
        },
      },
      loading ? '…' : String(todayCans),
      h('span', {
        style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, fontWeight: 400 },
      }, t('today'))),
      h('span', {
        style: {
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 10,
          lineHeight: '13px',
          whiteSpace: 'nowrap',
        },
      }, failed ? t('unavailable') : `${totalCans} ${t('total')}`),
      h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute',
          top: -8,
          right: -8,
          minWidth: 24,
          height: 24,
          boxSizing: 'border-box',
          padding: '0 6px',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '2px solid var(--dsw-alias-bg-layer-1)',
          background: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
          color: '#fff',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1,
        },
      }, badge)),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en: dictionaries.en, zh: dictionaries.zh }),
          'monster-tracker: dictionaries',
        )
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'monster-tracker-float',
          order: 60,
          locale: NS,
        }, MonsterCan))
      },
    }
  },
})
