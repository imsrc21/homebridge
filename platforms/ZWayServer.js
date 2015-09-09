var debug = require('debug')('ZWayServer');
var Service = require("HAP-NodeJS").Service;
var Characteristic = require("HAP-NodeJS").Characteristic;
var types = require("HAP-NodeJS/accessories/types.js");
var request = require("request");
var tough = require('tough-cookie');
var Q = require("q");

var zwshkDeviceClasses = [
    {
        primaryType: "switchBinary",
        subTypes: {
            "battery": true,
            "sensorMultilevel.Electric": true
        },
        tcType: types.SWITCH_TCTYPE
    }
    ,
    {
        primaryType: "thermostat",
        subTypes: {
            "sensorMultiLevel.Temperature": true,
            "battery": true
        },
        tcType: types.THERMOSTAT_TCTYPE
    }
    ,
    {
        primaryType: "sensorBinary.Door/Window",
        subTypes: {
            "battery": true
        },
        tcType: types.SENSOR_TCTYPE
    }
    ,
    {
        primaryType: "sensorMultilevel.Temperature",
        subTypes: {
            "battery": true
        },
        tcType: types.SENSOR_TCTYPE
    }
    ,
    {
        primaryType: "switchMultilevel",
        subTypes: {
            "battery": true
        },
        tcType: types.LIGHTBULB_TCTYPE
    }
];

function ZWayServerPlatform(log, config){
    this.log          = log;
    this.url          = config["url"];
    this.login        = config["login"];
    this.password     = config["password"];
    this.name_overrides = config["name_overrides"];
    this.batteryLow   = config["battery_low_level"];
    this.pollInterval = config["poll_interval"] || 2;
    this.lastUpdate   = 0;
    this.cxVDevMap    = {};
    this.vDevStore    = {};
    this.sessionId = "";
    this.jar = request.jar(new tough.CookieJar());
}

ZWayServerPlatform.getVDevTypeKey = function(vdev){
    return vdev.deviceType + (vdev.metrics && vdev.metrics.probeTitle ? "." + vdev.metrics.probeTitle : "")
}

ZWayServerPlatform.prototype = {

    zwayRequest: function(opts){
        var that = this;
        var deferred = Q.defer();

        opts.jar = true;//this.jar;
        opts.json = true;
        opts.headers = {
            "Cookie": "ZWAYSession=" + this.sessionId
        };
opts.proxy = 'http://localhost:8888';

        request(opts, function(error, response, body){
            if(response.statusCode == 401){
                debug("Authenticating...");
                request({
                    method: "POST",
                    url: that.url + 'ZAutomation/api/v1/login',
proxy: 'http://localhost:8888',
                    body: { //JSON.stringify({
                        "form": true,
                        "login": that.login,
                        "password": that.password,
                        "keepme": false,
                        "default_ui": 1
                    },
                    headers: {
                        "Accept": "application/json",
                        "Content-Type": "application/json"
                    },
                    json: true,
                    jar: true//that.jar
                }, function(error, response, body){
                    if(response.statusCode == 200){
                        that.sessionId = body.data.sid;
                        opts.headers["Cookie"] = "ZWAYSession=" + that.sessionId;
                        debug("Authenticated. Resubmitting original request...");
                        request(opts, function(error, response, body){
                            if(response.statusCode == 200){
                                deferred.resolve(body);
                            } else {
                                deferred.reject(response);
                            }
                        });
                    } else {
                        deferred.reject(response);
                    }
                });
            } else if(response.statusCode == 200) {
                deferred.resolve(body);
            } else {
                deferred.reject(response);
            }
        });
        return deferred.promise;
    }
    ,

    accessories: function(callback) {
        debug("Fetching Z-Way devices...");

        var that = this;
        var foundAccessories = [];

        this.zwayRequest({
            method: "GET",
            url: this.url + 'ZAutomation/api/v1/devices'
        }).then(function(result){
            this.lastUpdate = result.data.updateTime;
            
            var devices = result.data.devices;
            var groupedDevices = {};
            for(var i = 0; i < devices.length; i++){
                var vdev = devices[i];
                if(vdev.tags.indexOf("HomeBridge:Skip") >= 0) { debug("Tag says skip!"); continue; }
                var gdid = vdev.id.replace(/^(.*?)_zway_(\d+-\d+)-\d.*/, '$1_$2');
                var gd = groupedDevices[gdid] || (groupedDevices[gdid] = {devices: [], types: {}, primary: undefined});
                gd.devices.push(vdev);
                gd.types[ZWayServerPlatform.getVDevTypeKey(vdev)] = gd.devices.length - 1;
                gd.types[vdev.deviceType] = gd.devices.length - 1; // also include the deviceType only as a possibility
            }
            //TODO: Make a second pass, re-splitting any devices that don't make sense together
            for(var gdid in groupedDevices) {
                if(!groupedDevices.hasOwnProperty(gdid)) continue;
                
                // Debug/log...
                debug('Got grouped device ' + gdid + ' consiting of devices:');
                var gd = groupedDevices[gdid];
                for(var j = 0; j < gd.devices.length; j++){
                    debug(gd.devices[j].id + " - " + gd.devices[j].deviceType + (gd.devices[j].metrics && gd.devices[j].metrics.probeTitle ? "." + gd.devices[j].metrics.probeTitle : ""));
                }
                
                var accessory = null;
                for(var ti = 0; ti < zwshkDeviceClasses.length; ti++){
                    if(gd.types[zwshkDeviceClasses[ti].primaryType] !== undefined){
                        gd.primary = gd.types[zwshkDeviceClasses[ti].primaryType];
                        var pd = gd.devices[gd.primary];
                        var name = pd.metrics && pd.metrics.title ? pd.metrics.title : pd.id;
                        debug("Using class with primaryType " + zwshkDeviceClasses[ti].primaryType + ", " + name + " (" + pd.id + ") as primary.");
                        accessory = new ZWayServerAccessory(name, zwshkDeviceClasses[ti], gd, that);
                        break;
                    }
                }
                
                if(!accessory)
                    debug("WARN: Didn't find suitable device class!");
                else
                    foundAccessories.push(accessory);
                
            }
//foundAccessories = foundAccessories.slice(0, 10); // Limit to a few devices for testing...
            callback(foundAccessories);
            
            // Start the polling process...
            this.pollingTimer = setTimeout(this.pollUpdate.bind(this), this.pollInterval*1000);
            
        }.bind(this));

    }
    ,
    
    pollUpdate: function(){
        //debug("Polling for updates since " + this.lastUpdate + "...");
        return this.zwayRequest({
            method: "GET",
            url: this.url + 'ZAutomation/api/v1/devices',
            qs: {since: this.lastUpdate}
        }).then(function(result){
            this.lastUpdate = result.data.updateTime;
            if(result.data && result.data.devices && result.data.devices.length){
                var updates = result.data.devices;
                debug("Got " + updates.length + " updates.");
                for(var i = 0; i < updates.length; i++){
                    var upd = updates[i];
                    if(this.cxVDevMap[upd.id]){
                        var vdev = this.vDevStore[upd.id];
                        vdev.metrics.level = upd.metrics.level;
                        vdev.updateTime = upd.updateTime;
                        var cxs = this.cxVDevMap[upd.id];
                        for(var j = 0; j < cxs.length; j++){
                            var cx = cxs[j];
                            if(typeof cx.zway_getValueFromVDev !== "function") continue;
                            var oldValue = cx.value;
                            var newValue = cx.zway_getValueFromVDev(vdev);
                            if(oldValue !== newValue){
                                cx.value = newValue;
                                cx.emit('change', { oldValue:oldValue, newValue:cx.value, context:null });
                                debug("Updated characteristic " + cx.displayName + " on " + vdev.metrics.title);
                            }
                        }
                    }
                }
            }
            
            // setup next poll...
            this.pollingTimer = setTimeout(this.pollUpdate.bind(this), this.pollInterval*1000);
        }.bind(this));
    }

}

function ZWayServerAccessory(name, dclass, devDesc, platform) {
  // device info
  this.name     = name;
  this.dclass   = dclass;
  this.devDesc  = devDesc;
  this.platform = platform;
  this.log      = platform.log;
}


ZWayServerAccessory.prototype = {
    
    getVDev: function(vdev){
        return this.platform.zwayRequest({
            method: "GET",
            url: this.platform.url + 'ZAutomation/api/v1/devices/' + vdev.id
        })//.then(function());
    }
    ,
    command: function(vdev, command, value) {
        return this.platform.zwayRequest({
            method: "GET",
            url: this.platform.url + 'ZAutomation/api/v1/devices/' + vdev.id + '/command/' + command,
            qs: (value === undefined ? undefined : value)
        });
    },
    
    getVDevServices: function(vdev){
        var typeKey = ZWayServerPlatform.getVDevTypeKey(vdev);
        var services = [], service;
        switch (typeKey) {
            case "switchBinary":
                services.push(new Service.Switch(vdev.metrics.title));
                break;
            case "switchMultilevel":
                services.push(new Service.Lightbulb(vdev.metrics.title));
                break;
            case "thermostat":
                services.push(new Service.Thermostat(vdev.metrics.title));
                break;
            case "sensorMultilevel.Temperature":
                services.push(new Service.TemperatureSensor(vdev.metrics.title));
                break;
            case "sensorBinary.Door/Window":
                //services.push(new Service.GarageDoorOpener(vdev.metrics.title));
                break;
            case "battery.Battery":
                services.push(new Service.BatteryService(vdev.metrics.title));
                break;
        }
        
        var validServices =[];
        for(var i = 0; i < services.length; i++){
            if(this.configureService(services[i], vdev))
                validServices.push(services[i]);
        }
        
        return validServices;
    }
    ,
    uuidToTypeKeyMap: null
    ,
    getVDevForCharacteristic: function(cx, vdevPreferred){
        var map = this.uuidToTypeKeyMap;
        if(!map){
            this.uuidToTypeKeyMap = map = {};
            map[(new Characteristic.On).UUID] = ["switchBinary","switchMultilevel"];
            map[(new Characteristic.Brightness).UUID] = ["switchMultilevel"];
            map[(new Characteristic.CurrentTemperature).UUID] = ["sensorMultilevel.Temperature","thermostat"];
            map[(new Characteristic.TargetTemperature).UUID] = ["thermostat"];
            map[(new Characteristic.TemperatureDisplayUnits).UUID] = ["sensorMultilevel.Temperature","thermostat"]; //TODO: Always a fixed result
            map[(new Characteristic.CurrentHeatingCoolingState).UUID] = ["thermostat"]; //TODO: Always a fixed result
            map[(new Characteristic.TargetHeatingCoolingState).UUID] = ["thermostat"]; //TODO: Always a fixed result
            map[(new Characteristic.CurrentDoorState).UUID] = ["sensorBinary.Door/Window","sensorBinary"];
            map[(new Characteristic.TargetDoorState).UUID] = ["sensorBinary.Door/Window","sensorBinary"]; //TODO: Always a fixed result
            map[(new Characteristic.ObstructionDetected).UUID] = ["sensorBinary.Door/Window","sensorBinary"]; //TODO: Always a fixed result
            map[(new Characteristic.BatteryLevel).UUID] = ["battery.Battery"];
            map[(new Characteristic.StatusLowBattery).UUID] = ["battery.Battery"];
            map[(new Characteristic.ChargingState).UUID] = ["battery.Battery"]; //TODO: Always a fixed result
        }
        
        if(cx instanceof Characteristic.Name) return vdevPreferred;

        // Special case!: If cx is a CurrentTemperature, ignore the preferred device...we want the sensor if available!
        if(cx instanceof Characteristic.CurrentTemperature) vdevPreferred = null;
        //
        
        var typekeys = map[cx.UUID];
        if(typekeys === undefined) return null;
        
        if(vdevPreferred && typekeys.indexOf(ZWayServerPlatform.getVDevTypeKey(vdevPreferred)) >= 0){
            return vdevPreferred;
        }
        
        var candidates = this.devDesc.devices;
        for(var i = 0; i < typekeys.length; i++){
            for(var j = 0; j < candidates.length; j++){
                if(ZWayServerPlatform.getVDevTypeKey(candidates[j]) === typekeys[i]) return candidates[j];
            }
        }
        
        return null;
    }
    ,
    configureCharacteristic: function(cx, vdev){
        var that = this;
        
        // Add this combination to the maps...
        if(!this.platform.cxVDevMap[vdev.id]) this.platform.cxVDevMap[vdev.id] = [];
        this.platform.cxVDevMap[vdev.id].push(cx);
        if(!this.platform.vDevStore[vdev.id]) this.platform.vDevStore[vdev.id] = vdev;
        
        if(cx instanceof Characteristic.Name){
            cx.zway_getValueFromVDev = function(vdev){
                return vdev.metrics.title;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                callback(false, that.name);
            });
            cx.writable = false;
            return cx;
        }
        
        if(cx instanceof Characteristic.On){
            cx.zway_getValueFromVDev = function(vdev){
                var val = false;
                if(vdev.metrics.level === "on"){
                    val = true;
                } else if(vdev.metrics.level <= 5) {
                    val = false;
                } else if (vdev.metrics.level > 5) {
                    val = true;
                }
                return val;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                this.getVDev(vdev).then(function(result){
                    debug("Got value: " + cx.zway_getValueFromVDev(result.data) + ", for " + vdev.metrics.title + ".");
                    callback(false, cx.zway_getValueFromVDev(result.data));
                });
            }.bind(this));
            cx.on('set', function(powerOn, callback){
                this.command(vdev, powerOn ? "on" : "off").then(function(result){
                    callback();
                });
            }.bind(this));
            return cx;
        }

        if(cx instanceof Characteristic.Brightness){
            cx.zway_getValueFromVDev = function(vdev){
                return vdev.metrics.level;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                this.getVDev(vdev).then(function(result){
                    debug("Got value: " + cx.zway_getValueFromVDev(result.data) + ", for " + vdev.metrics.title + ".");
                    callback(false, cx.zway_getValueFromVDev(result.data));
                });
            }.bind(this));
            cx.on('set', function(level, callback){
                this.command(vdev, "exact", {level: parseInt(level, 10)}).then(function(result){
                    callback();
                });
            }.bind(this));
            return cx;
        }

        if(cx instanceof Characteristic.CurrentTemperature){
            cx.zway_getValueFromVDev = function(vdev){
                return vdev.metrics.level;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                this.getVDev(vdev).then(function(result){
                    debug("Got value: " + cx.zway_getValueFromVDev(result.data) + ", for " + vdev.metrics.title + ".");
                    callback(false, cx.zway_getValueFromVDev(result.data));
                });
            }.bind(this));
            cx.minimumValue = vdev.metrics && vdev.metrics.min !== undefined ? vdev.metrics.min : -40;
            cx.maximumValue = vdev.metrics && vdev.metrics.max !== undefined ? vdev.metrics.max : 999;
            return cx;
        }

        if(cx instanceof Characteristic.TargetTemperature){
            cx.zway_getValueFromVDev = function(vdev){
                return vdev.metrics.level;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                this.getVDev(vdev).then(function(result){
                    debug("Got value: " + cx.zway_getValueFromVDev(result.data) + ", for " + vdev.metrics.title + ".");
                    callback(false, cx.zway_getValueFromVDev(result.data));
                });
            }.bind(this));
            cx.on('set', function(level, callback){
                this.command(vdev, "exact", {level: parseInt(level, 10)}).then(function(result){
                    //debug("Got value: " + result.data.metrics.level + ", for " + vdev.metrics.title + ".");
                    callback();
                });
            }.bind(this));
            cx.minimumValue = vdev.metrics && vdev.metrics.min !== undefined ? vdev.metrics.min : 5;
            cx.maximumValue = vdev.metrics && vdev.metrics.max !== undefined ? vdev.metrics.max : 40;
            return cx;
        }

        if(cx instanceof Characteristic.TemperatureDisplayUnits){
            //TODO: Always in °C for now.
            cx.zway_getValueFromVDev = function(vdev){
                return Characteristic.TemperatureDisplayUnits.CELSIUS;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                callback(false, Characteristic.TemperatureDisplayUnits.CELSIUS);
            });
            cx.writable = false;
            return cx;
        }
        
        if(cx instanceof Characteristic.CurrentHeatingCoolingState){
            //TODO: Always HEAT for now, we don't have an example to work with that supports another function.
            cx.zway_getValueFromVDev = function(vdev){
                return Characteristic.CurrentHeatingCoolingState.HEAT;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                callback(false, Characteristic.CurrentHeatingCoolingState.HEAT);
            });
            return cx;
        }
        
        if(cx instanceof Characteristic.TargetHeatingCoolingState){
            //TODO: Always HEAT for now, we don't have an example to work with that supports another function.
            cx.zway_getValueFromVDev = function(vdev){
                return Characteristic.TargetHeatingCoolingState.HEAT;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                callback(false, Characteristic.TargetHeatingCoolingState.HEAT);
            });
            cx.writable = false;
            return cx;
        }
        
        if(cx instanceof Characteristic.CurrentDoorState){
            cx.zway_getValueFromVDev = function(vdev){
                return vdev.metrics.level === "off" ? Characteristic.CurrentDoorState.CLOSED : Characteristic.CurrentDoorState.OPEN;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                this.getVDev(vdev).then(function(result){
                    debug("Got value: " + cx.zway_getValueFromVDev(result.data) + ", for " + vdev.metrics.title + ".");
                    callback(false, cx.zway_getValueFromVDev(result.data));
                });
            }.bind(this));
        }
        
        if(cx instanceof Characteristic.TargetDoorState){
            //TODO: We only support this for Door sensors now, so it's a fixed value.
            cx.zway_getValueFromVDev = function(vdev){
                return Characteristic.TargetDoorState.CLOSED;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                callback(false, Characteristic.TargetDoorState.CLOSED);
            });
            //cx.readable = false;
            cx.writable = false;
        }
        
        if(cx instanceof Characteristic.ObstructionDetected){
            //TODO: We only support this for Door sensors now, so it's a fixed value.
            cx.zway_getValueFromVDev = function(vdev){
                return false;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                callback(false, false);
            });
            //cx.readable = false;
            cx.writable = false;
        }
        
        if(cx instanceof Characteristic.BatteryLevel){
            cx.zway_getValueFromVDev = function(vdev){
                return vdev.metrics.level;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                this.getVDev(vdev).then(function(result){
                    debug("Got value: " + cx.zway_getValueFromVDev(result.data) + ", for " + vdev.metrics.title + ".");
                    callback(false, cx.zway_getValueFromVDev(result.data));
                });
            }.bind(this));
        }
        
        if(cx instanceof Characteristic.StatusLowBattery){
            cx.zway_getValueFromVDev = function(vdev){
                return vdev.metrics.level <= that.platform.batteryLow ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                this.getVDev(vdev).then(function(result){
                    debug("Got value: " + cx.zway_getValueFromVDev(result.data) + ", for " + vdev.metrics.title + ".");
                    callback(false, cx.zway_getValueFromVDev(result.data));
                });
            }.bind(this));
        }
        
        if(cx instanceof Characteristic.ChargingState){
            //TODO: No known chargeable devices(?), so always return false.
            cx.zway_getValueFromVDev = function(vdev){
                return Characteristic.ChargingState.NOT_CHARGING;
            };
            cx.value = cx.zway_getValueFromVDev(vdev);
            cx.on('get', function(callback, context){
                debug("Getting value for " + vdev.metrics.title + ", characteristic \"" + cx.displayName + "\"...");
                callback(false, Characteristic.ChargingState.NOT_CHARGING);
            });
            //cx.readable = false;
            cx.writable = false;
        }
        
    }
    ,
    configureService: function(service, vdev){
        var success = true;
        for(var i = 0; i < service.characteristics.length; i++){
            var cx = service.characteristics[i];
            var vdev = this.getVDevForCharacteristic(cx, vdev);
            if(!vdev){
                success = false;
                debug("ERROR! Failed to configure required characteristic \"" + service.characteristics[i].displayName + "\"!");
            }
            cx = this.configureCharacteristic(cx, vdev);
        }
        for(var i = 0; i < service.optionalCharacteristics.length; i++){
            var cx = service.optionalCharacteristics[i];
            var vdev = this.getVDevForCharacteristic(cx);
            if(!vdev) continue;
            cx = this.configureCharacteristic(cx, vdev);
            if(cx) service.addCharacteristic(cx);
        }
        return success;
    }
    ,
    getServices: function() {
        var that = this;
        
        var informationService = new Service.AccessoryInformation();
    
        informationService
                .setCharacteristic(Characteristic.Name, this.name)
                .setCharacteristic(Characteristic.Manufacturer, "Z-Wave.me")
                .setCharacteristic(Characteristic.Model, "Virtual Device (VDev version 1)")
                .setCharacteristic(Characteristic.SerialNumber, "VDev-" + this.devDesc.devices[this.devDesc.primary].h) //FIXME: Is this valid?);

        var services = [informationService];
    
        services = services.concat(this.getVDevServices(this.devDesc.devices[this.devDesc.primary]));
        
        if(this.devDesc.types["battery.Battery"]){
            services = services.concat(this.getVDevServices(this.devDesc.devices[this.devDesc.types["battery.Battery"]]));
        }
        
        debug("Loaded services for " + this.name);
        return services;
    }
};

module.exports.accessory = ZWayServerAccessory;
module.exports.platform = ZWayServerPlatform;
