# Installation bloquée : « application toujours lancée »

Les versions v0.19.0 et v0.20.0 utilisent le même exécutable pour la fenêtre du studio et pour le relais MCP sans fenêtre. Une connexion IA ou SSH peut maintenir ce relais en arrière-plan après la fermeture de l’interface. Windows ne peut alors pas remplacer l’exécutable pendant la mise à jour.

## Débloquer une ancienne version

Fermez normalement le studio, puis exécutez ceci dans PowerShell avec le compte Windows habituel du studio :

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^(AI Dubbing Studio|ai-dubbing-studio)\.exe$' -and
    $_.CommandLine -match '\s--mcp\s'
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Cette commande ferme uniquement les relais MCP des exécutables portant ces noms. Elle ne supprime aucun projet, fichier audio, modèle ou essai. Relancez ensuite l’installeur, puis le studio. Si le blocage persiste et qu’aucun relais n’est trouvé, relevez le message exact et les processus concernés ; la cause peut être différente.

## Correction v0.20.1

- Le relais surveille la présence de sa session et la réponse du studio, même lorsque son entrée standard reste ouverte. Il se termine si l’application disparaît, si MCP est désactivé ou si le jeton de session change. Une fermeture normale du client libère également le processus.
- Avant de lancer l’installeur depuis l’application, le studio sauvegarde le projet et suspend le serveur MCP. Un délai de cinq secondes laisse les relais libérer l’exécutable. Les tâches sont vérifiées avant et après cette attente : une tâche démarrée entre-temps empêche l’installation.
- Le choix « MCP activé » reste enregistré pour le redémarrage. Si le lancement de l’installeur échoue, le serveur MCP est restauré selon ce choix. Un client IA dont le relais s’est terminé doit reconnecter sa session.
- La procédure manuelle ci-dessus peut encore être nécessaire pour quitter un relais d’une version antérieure à v0.20.1 avant la première installation corrigée.

Les tests du programme réel gardent volontairement l’entrée du relais ouverte et vérifient sa sortie après arrêt du serveur, suppression ou rotation de la session, ainsi que la fermeture normale du client. Les scénarios de l’interface vérifient l’ordre de préparation, la restauration après échec et le refus d’installer pendant un traitement.
