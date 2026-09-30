#!/bin/zsh

A="$HOME/Dropbox/DEV-Ubuntu-Shared/GITHUB_LOCAL_Boatface/merkle-to-words"
B="/Volumes/edit/Desktop/MERKLE_AUDIO_ABLETON_SESSIONS"

echo "=== MERKLE MIDI SYNC ==="
echo ""
echo "A → B"
rsync -avu --include='*/' --include='*.mid' --exclude='*' "$A/" "$B/"

echo ""
echo "B → A"
rsync -avu --include='*/' --include='*.mid' --exclude='*' "$B/" "$A/"

echo ""
echo "Done."
read -k 1 "?Press any key to close..."
echo ""
