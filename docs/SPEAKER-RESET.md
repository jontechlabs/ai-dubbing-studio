# Remise à zéro des locuteurs et capture des vignettes

Dans **Personnages → Remettre les locuteurs à zéro**, choisissez un des deux modes puis confirmez :

- **Conserver les fiches, vignettes et références vocales** : retire l’analyse et les attributions de toutes les répliques, y compris les sous-doublages de voix isolées. Les fiches, noms, vignettes, références et bibliothèques vocales restent disponibles.
- **Retirer aussi les fiches, vignettes et références des personnages du projet** : retire également ces fiches et leurs bibliothèques. Les fichiers restent sur disque pour les essais historiques et l’annulation. Les références de fichiers audio importés indépendamment des personnages restent disponibles.

Les sous-titres source et traduits, les pistes, le montage et tous les essais de doublage sont conservés. Les essais sélectionnés restent accessibles à l’écoute. Les validations communes liées à l’ancien locuteur repassent à vérifier. **Ctrl+Z** annule l’opération, **Ctrl+Y** la rétablit. Vous pouvez ensuite relancer l’identification sur tout le projet ou une zone. Une tâche en cours empêche la remise à zéro.

## Vignettes identiques pour plusieurs personnages

Il n’est pas nécessaire de relancer l’identification si les attributions des voix sont correctes. La v0.36.0 corrige le choix automatique : la capture utilise une réplique du personnage affiché, avec priorité à celle sélectionnée dans l’éditeur si elle lui appartient. Elle ne reprend plus automatiquement la réplique d’un autre personnage. Un personnage sans réplique exige un choix explicite.

Ouvrez **Choisir ou recadrer la vignette**, vérifiez **Réplique pour la vignette**, puis **Capturer la vignette** pour corriger les anciennes captures. Changer de réplique efface une position vidéo manuelle précédente et reprend le milieu de la nouvelle réplique. Vous pouvez toujours choisir explicitement une autre image ou un cadrage manuel.

Le cadrage automatique repère un visage dans l’image ; il ne prouve pas que ce visage est celui du locuteur. Pour une voix hors champ, des répliques simultanées ou un plan montrant plusieurs visages, choisissez une autre position ou recadrez manuellement. La vidéo principale reste intacte.

## MCP

`studio_reset_speakers` exige le contexte courant et un mode explicite : `assignments` pour conserver les fiches, `characters` pour les retirer. L’opération est atomique et utilise l’historique du studio. Un contexte périmé ou une tâche active est refusé. Le catalogue contient 142 outils ; le format du projet reste 26.
