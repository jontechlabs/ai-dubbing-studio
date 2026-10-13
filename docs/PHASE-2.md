# Phase 2 — édition temporelle et calage automatique

## Caler les deux SRT

1. Importez le SRT original et le SRT traduit, depuis des fichiers ou les pistes texte du MKV.
2. Ouvrez **Analyser** puis choisissez le **SRT de référence**. Ses timings resteront en place.
3. Cliquez sur **Calculer le calage**. Le studio estime le décalage et la dérive, puis propose des associations chronologiques.
4. Examinez les exemples avant/après, le taux de sous-titres associés et le nombre de blocs à vérifier.
5. Cliquez sur **Appliquer le calage**, puis écoutez quelques répliques au début, au milieu et à la fin.
6. Exportez les SRT depuis **Exporter**. **Ctrl+Z** annule le calage pendant la session ; **Ctrl+Y** le rétablit.

Le studio peut choisir l’original ou la traduction comme référence. Une réplique peut correspondre à plusieurs blocs de l’autre SRT, jusqu’à trois. Le texte de chacun reste éditable séparément. Les blocs non associés restent à leur place et sont signalés. Le calcul doit être relancé si le projet a changé depuis l’aperçu.

Le décalage recherché est limité à deux minutes, avec une dérive globale comprise entre −10 % et +10 %. Il faut au moins trois associations et 60 % de couverture. Les motifs trop répétitifs ou insuffisants sont refusés. Ces seuils évaluent les timings ; ils ne prouvent pas que les textes se traduisent correctement.

Ce calage synchronise **les SRT entre eux**. Il ne reconnaît pas les voix et ne replace pas les mots sur l’audio. Le SRT de référence doit déjà convenir à la vidéo. Deux montages différents peuvent nécessiter des corrections manuelles par sections.

## Éditer les timecodes et la timeline

Sélectionnez une réplique. Choisissez **Les deux SRT**, **Original** ou **Sous-titre affiché**, saisissez le début et la fin au format `HH:MM:SS.mmm`, puis cliquez sur **Recaler**. La durée doit être d’au moins 100 ms. Si plusieurs blocs sont associés, leurs positions internes sont ajustées proportionnellement dans la nouvelle plage.

Dans la timeline, glissez le centre d’un bloc pour le déplacer ou l’un de ses bords pour le redimensionner. Maintenez **Maj** pour aimanter près de la tête de lecture ou d’un autre bord, dans une tolérance de 120 ms. Avec un bloc au clavier, **←/→** déplace de 100 ms et **Maj+←/→** de 1 seconde. Les blocs affichent les timings réels de chaque SRT.

Les commandes de zoom, de zoom sur sélection et d’ajustement restent disponibles. Le bouton avec l’icône audio change la hauteur des pistes. La timeline peut être agrandie en tirant son séparateur.

## Diviser et fusionner

Placez la tête de lecture dans la réplique, à au moins 100 ms de chaque extrémité, puis cliquez sur **Diviser**. Les blocs qui traversent ce point sont divisés dans les deux SRT. Le texte est réparti approximativement près d’une limite de mot ou de caractère complet ; corrigez-le à l’écoute. Le texte de prononciation indépendant est également réparti s’il existe.

**Fusionner** joint la réplique sélectionnée à la suivante dans l’ordre temporel. Le studio crée un bloc par SRT avec les textes réunis sur plusieurs lignes. Les exports SRT reflètent division et fusion. Annuler restaure les blocs précédents. Les fichiers audio de générations restent conservés ; les sélections de prises des répliques restructurées sont retirées et les textes sont à revoir.

## Forme d’onde

La piste **Audio original** affiche une forme d’onde calculée sur l’audio choisi à l’import. Le calcul local peut être suivi et annulé dans **Traitements**. Son résultat est mis en cache dans le projet pour les ouvertures suivantes. Le calcul n’empêche pas d’éditer les sous-titres. Une vidéo sans piste audio ne fournit pas de forme d’onde. Si le calcul échoue ou est annulé, le lien **Réessayer** apparaît dans la piste.

L’aperçu navigateur calcule la forme d’onde avec Web Audio et dépend des formats décodables par le navigateur. L’application desktop utilise FFmpeg et la piste choisie du média original.

## English quick guide

Import both SRTs, open **Analyze**, choose the reference, and **Calculate synchronization**. Review the timing proposal before **Apply synchronization**. Only confirmed groups of the other SRT are retimed; unmatched cues keep their timings. Ctrl+Z undoes the operation. Matching uses timing patterns, without speech recognition or translation semantics, and refuses insufficient/ambiguous results.

Use the editor’s start/end fields for either SRT or both. Drag blocks to move them, drag edges to resize, hold Shift to snap, and use arrows for 100 ms steps. **Split** cuts at the playhead with approximate text distribution; **Merge** joins the next chronological line into one cue per role. Review the text after either operation. Exports and saved projects retain these changes. The selected audio track’s waveform is computed locally, cached and cancellable from Processing.
