const fetch=require("node-fetch");
const fs=require("fs");
const {
	encodeBase64,
	decodeBase64,
	jsonParseTry,
}=globals.functions;

const configFile="data/spotifyLoginData.json";
const URLS={
	"authorize":	"https://accounts.spotify.com/authorize",
	"token":		"https://accounts.spotify.com/api/token",
	"playlists":	"https://api.spotify.com/v1/me/playlists",
	"devices":		"https://api.spotify.com/v1/me/player/devices",
	"play":			"https://api.spotify.com/v1/me/player/play",
	"pause":		"https://api.spotify.com/v1/me/player/pause",
	"next":			"https://api.spotify.com/v1/me/player/next",
	"previous":		"https://api.spotify.com/v1/me/player/previous",
	"player":		"https://api.spotify.com/v1/me/player",
	"volume": 		"https://api.spotify.com/v1/me/player/volume",
	"tracks": 		"https://api.spotify.com/v1/playlists/[playListId]/tracks",
	"nowPlaying":	"https://api.spotify.com/v1/me/player/currently-playing",
	"shuffle":		"https://api.spotify.com/v1/me/player/shuffle",
};

this.start=()=>{
	this.config=this.readConf();
	this.infos=null;
	this.infos_raw=null;

	if(this.config.access_token){
		this.callApi({
			method:"get",
			url:URLS.player,
			request:"get track",
		});
	}else if(this.config.refresh_token&&this.config.refresh_token){
		this.refresh_access_token();
	}
	setInterval(()=>{
		this.callApi({
			method:"get",
			url:URLS.player,
			request:"get track",
		});
	},10e3);
}
this.saveConfig=()=>{
	// save the config into file;
	fs.writeFileSync(configFile,JSON.stringify(this.config,null,2).split("  ").join("\t"));
}
this.readConf=()=>{
	let fileData="";
	try{fileData=jsonParseTry(fs.readFileSync(configFile,"utf8"));}
	catch(e){fileData=false;}

	if(!fileData||typeof(fileData)!="object"){
		log("ERROR: config '"+configFile+"' cant read");
		throw new Error("config not exist!");
	}

	return fileData;
}
this.HandleServerResponse=data=>{
	const {
		serverResponse,
		clientRequest,
		args,
	}=data;
	if(serverResponse.error){
		const status=serverResponse.error.status;
		if(status==401){
			this.refresh_access_token();
		}
		else if(status==503){
			this.callApi(args);
		}
	}
	if(clientRequest=="get track"){
		if(serverResponse.error){
			this.infos=null;
			return false;
		}
		let i={};
		let infos_raw;
		try{
			i={
				playing:serverResponse.is_playing,
				device:{
					id:serverResponse.device.id,
					name:serverResponse.device.name,
					type:serverResponse.device.type,
					volume:serverResponse.device.volume_percent,
					active:serverResponse.device.is_active,
				},
				track:{
					name:serverResponse.item.name,
					imgs:serverResponse.item.album.images,
					progress:serverResponse.progress_ms,
					length:serverResponse.item.duration_ms,
					mp3:serverResponse.item.preview_url,
					url:serverResponse.item.external_urls.spotify,
				},
			};
			infos_raw=serverResponse;
		}catch(e){
			i=null;
			infos_raw=null;
			//log("cant load data");
		}
		this.infos=i;
		this.infos_raw=infos_raw;
	}
	if(clientRequest=="get access_token"){
		this.config.access_token=serverResponse.access_token;
		this.saveConfig();
	}
}
this.callApi=data=>{
	const {
		body,
		method="get",
		url,
		request,
		auth="token",
		contentType="application/json",
	}=data;
	fetch(url,{
		method:method.toUpperCase(),
		headers:{
			"Content-Type":contentType,
			"Authorization":(
				auth=="token"?
					"Bearer "+this.config.access_token:
					"Basic "+encodeBase64(this.config.client_id+":"+this.config.client_secret)
			),
		},
		body:typeof(body)=="string"?body:JSON.stringify(body),
	})
		.then(res=>res.text())
		.then(res=>this.HandleServerResponse({
			serverResponse:jsonParseTry(res),
			clientRequest:request,
			args:data,
		}))
		.catch(res=>{
			this.infos=null;
			this.infos_raw=null;
			//log("cant call api");
		});
}
this.refresh_access_token=()=>{
	let body="grant_type=refresh_token";
	body+="&refresh_token="+this.config.refresh_token;
	body+="&client_id="+this.config.client_id;
	this.callApi({
		method:"post",
		url:URLS.token,
		request:"get access_token",
		body,
		auth:"client_secret",
		contentType:"application/x-www-form-urlencoded",
	});
}
this.playbackAction=(data)=>{
	const {action}=data;

	if(action=="next"){
		this.callApi({
			url:URLS.next,
			method:"post",
		});
	}
	else if(action=="previous"){
		this.callApi({
			url:URLS.previous,
			method:"post",
		});
	}
}

this.stop=()=>{
	this.saveConfig();
	this.infos=null;
	this.infos_raw=null;
}
