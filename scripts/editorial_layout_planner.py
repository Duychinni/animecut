"""Editorial scene and layout planning for production reframe timelines.

This layer runs after visual/audio observation and before FFmpeg rendering. It
turns detector evidence into an explicit editorial decision; it does not detect
faces, track speakers, or render pixels itself.
"""

from collections import Counter


SCENE_TYPES = {
    'SINGLE_SPEAKER', 'TWO_PERSON', 'THREE_PERSON', 'FOUR_PERSON',
    'BROLL', 'PICTURE_IN_PICTURE', 'UNKNOWN',
}

LAYOUTS = {
    'SINGLE_SPEAKER_CROP', 'ACTIVE_SPEAKER_CROP', 'TWO_PERSON_CONVERSATION',
    'THREE_PERSON_COMPOSITION', 'PRESERVE_GRID', 'BROLL_FILL',
    'PICTURE_IN_PICTURE', 'SPEAKER_WITH_CONTEXT', 'SAFE_ORIGINAL',
}

FIXED_TWO_REGION_LAYOUTS = {
    'FIXED_TWO_REGION_CONVERSATION',
    'FIXED_TWO_PANEL_INTERVIEW',
}


def _candidate_hint(candidate_plan, key, allowed, fallback):
    value = str((candidate_plan or {}).get(key, '')).strip().upper()
    return value if value in allowed else fallback


def _classify_visual_scene(segment):
    mode = str(segment.get('mode', ''))
    wide_kind = str(segment.get('wideKind', ''))
    grid_template = str(segment.get('gridTemplate', ''))
    # Median visibility prevents one-frame logos, audience faces, or inserted
    # photos from turning an entire scene into a three/four-person discussion.
    visible_count = int(segment.get('visibleCount') or segment.get('visibleCountMax') or 0)

    if wide_kind == 'broll':
        return 'BROLL', 'BROLL_FILL', 'Visual evidence indicates inserted footage or a context shot.'
    if mode == 'source_vertical' and visible_count <= 1:
        return 'SINGLE_SPEAKER', 'SINGLE_SPEAKER_CROP', 'Portrait source already contains one dominant subject.'
    if mode == 'stacked' and segment.get('topBox') and segment.get('bottomBox'):
        return 'TWO_PERSON', 'TWO_PERSON_CONVERSATION', 'Two independently tracked participants require conversation context.'
    if mode == 'grid' and grid_template == 'grid_4':
        return 'FOUR_PERSON', 'PRESERVE_GRID', 'Four tracked participants require a stable discussion grid.'
    if mode == 'grid' and grid_template in ('hero_3', 'grid_3'):
        return 'THREE_PERSON', 'THREE_PERSON_COMPOSITION', 'Three tracked participants require a stable group composition.'
    if visible_count >= 4:
        return 'FOUR_PERSON', 'PRESERVE_GRID', 'Four or more visible participants require the original discussion geometry.'
    if visible_count == 3:
        return 'THREE_PERSON', 'THREE_PERSON_COMPOSITION', 'Three visible participants require a group composition.'
    if mode == 'single':
        return 'SINGLE_SPEAKER', 'SINGLE_SPEAKER_CROP', 'A confident active-speaker crop is available.'
    if visible_count == 2:
        return 'TWO_PERSON', 'SPEAKER_WITH_CONTEXT', 'Two people are visible but independent conversation panes are not reliable.'
    return 'UNKNOWN', 'SAFE_ORIGINAL', 'Visual evidence is insufficient for a more aggressive composition.'


def plan_editorial_timeline(timeline, candidate_plan=None):
    """Annotate and safely constrain every timed renderer segment."""
    planned = []
    scene_hint = _candidate_hint(candidate_plan, 'scene_type', SCENE_TYPES, 'UNKNOWN')
    layout_hint = _candidate_hint(candidate_plan, 'recommended_layout', LAYOUTS, 'SAFE_ORIGINAL')
    context_required = bool((candidate_plan or {}).get('visual_context_required'))

    for raw_segment in timeline:
        segment = dict(raw_segment)
        scene_type, layout, reason = _classify_visual_scene(segment)

        fixed_two_region = segment.get('sourceLayout') in FIXED_TWO_REGION_LAYOUTS
        fixed_active_speaker = (
            fixed_two_region
            and segment.get('renderBranch') in ('active_speaker_left', 'active_speaker_right')
            and segment.get('mode') == 'single'
            and segment.get('primaryPanel') in ('left', 'right')
            and segment.get('primaryTrackId') is not None
        )

        # This renderer decision is authoritative. Once visual analysis has
        # classified a fixed two-region source and bound a confident speaker
        # to one panel, transcript/editorial hints may not widen, stack, or
        # recenter the shot between participants.
        if fixed_active_speaker:
            scene_type = 'SINGLE_SPEAKER'
            layout = 'ACTIVE_SPEAKER_CROP'
            reason = 'Confident fixed-region speaker selection requires a panel-bounded single-speaker crop.'
            segment['mode'] = 'single'
            segment['wideKind'] = None
            segment['editorialSceneType'] = scene_type
            segment['editorialLayout'] = layout
            segment['editorialReason'] = reason
            planned.append(segment)
            continue

        # Transcript intelligence is a prior, never permission to contradict
        # the observed frame. It may preserve context, but may not invent a
        # speaker count or force an unsafe crop.
        if scene_type == 'UNKNOWN' and scene_hint != 'UNKNOWN':
            scene_type = scene_hint
            layout = layout_hint
            reason = 'Transcript editorial hint used because visual classification was uncertain.'
        elif context_required and scene_type == 'TWO_PERSON' and layout == 'SINGLE_SPEAKER_CROP':
            layout = 'SPEAKER_WITH_CONTEXT'
            reason = 'Transcript plan requires the supporting participant or reaction context.'

        if layout == 'BROLL_FILL':
            segment['mode'] = 'wide_context'
            segment['wideKind'] = 'broll'
        elif layout == 'TWO_PERSON_CONVERSATION' and segment.get('topBox') and segment.get('bottomBox'):
            segment['mode'] = 'stacked'
            segment['wideKind'] = None
        elif layout in ('THREE_PERSON_COMPOSITION', 'PRESERVE_GRID') and segment.get('subjects'):
            segment['mode'] = 'grid'
            segment['wideKind'] = None
        elif layout in ('SPEAKER_WITH_CONTEXT', 'SAFE_ORIGINAL'):
            segment['mode'] = 'wide_context'
            segment['wideKind'] = 'safe_wide'
        elif layout in ('SINGLE_SPEAKER_CROP', 'ACTIVE_SPEAKER_CROP') and segment.get('points') and segment.get('mode') != 'source_vertical':
            segment['mode'] = 'single'
            segment['wideKind'] = None

        segment['editorialSceneType'] = scene_type
        segment['editorialLayout'] = layout
        segment['editorialReason'] = reason
        planned.append(segment)

    scene_counts = Counter(segment['editorialSceneType'] for segment in planned)
    layout_counts = Counter(segment['editorialLayout'] for segment in planned)
    durations = Counter()
    for segment in planned:
        duration = max(0.0, float(segment.get('end', 0.0)) - float(segment.get('start', 0.0)))
        durations[segment['editorialLayout']] += duration

    return planned, {
        'segments': len(planned),
        'scene_type_counts': dict(scene_counts),
        'layout_counts': dict(layout_counts),
        'layout_duration_seconds': {key: round(value, 3) for key, value in durations.items()},
    }
